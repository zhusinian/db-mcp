#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ConnectionManager, parseMongoCommand } from "./db.js";
import { classifySql } from "./sqlClassifier.js";

const readOnly = process.argv.includes("--readOnly") || process.argv.includes("--readonly");
const manager = new ConnectionManager();

const server = new McpServer({
  name: "db-mcp",
  version: "0.1.0",
});

const connectionIdSchema = z.string().optional().describe("Connection id. Defaults to the latest connection.");
const executeMongoDescription = `Execute a MongoDB command query. Use MongoDB command syntax, not Mongo shell JavaScript.
Do not generate db.collection.find(...) or db.users.aggregate(...). Instead generate command JSON such as {"find":"users","filter":{"active":true},"limit":10}.
For aggregate, include "cursor": {}, for example {"aggregate":"orders","pipeline":[{"$match":{"status":"paid"}}],"cursor":{}}.
Use query when providing a string; it must be valid Extended JSON. Use $oid/$date Extended JSON for BSON values.
In --readOnly mode, write/unknown commands are rejected, and aggregate with $out/$merge is treated as write.`;
const executeSqlDescription = `Execute one PostgreSQL or MySQL SQL statement with optional positional parameters.
Generate normal SQL, not MongoDB syntax. Use params instead of interpolating values into sql.
For PostgreSQL placeholders use $1, $2, ...; for MySQL placeholders use ?.
In --readOnly mode, write/transaction/unknown SQL is rejected.`;

server.tool(
  "connect",
  "Open or replace a dynamic PostgreSQL/MySQL/MongoDB connection.",
  {
    id: z.string().optional().describe("Optional connection id. Defaults to 'default'."),
    type: z.enum(["postgres", "mysql", "mongodb"]),
    connectionString: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().positive().optional(),
    database: z.string().optional(),
    user: z.string().optional(),
    password: z.string().optional(),
    ssl: z.boolean().optional(),
  },
  async (args) => {
    const connection = await manager.connect(args);
    return textResult({ connected: true, readOnly, ...connection });
  },
);

server.tool(
  "execute_mongodb",
  executeMongoDescription,
  {
    database: z.string().optional().describe("Database name. Defaults to the database from connect, or MongoDB driver's default."),
    command: z
      .record(z.unknown())
      .optional()
      .describe(
        "MongoDB command document object. Example find: { find: 'users', filter: { active: true }, limit: 10 }. Example aggregate: { aggregate: 'orders', pipeline: [{ $match: { status: 'paid' } }], cursor: {} }.",
      ),
    query: z
      .string()
      .optional()
      .describe(
        "MongoDB command as an Extended JSON string. Prefer this when the AI is asked to provide a query string. Do not use Mongo shell JavaScript. Example: {\"find\":\"users\",\"filter\":{\"_id\":{\"$oid\":\"66f000000000000000000001\"}},\"limit\":1}.",
      ),
    commandJson: z.string().optional().describe("Alias of query for Extended JSON command strings. Prefer query for new calls."),
    connectionId: connectionIdSchema,
  },
  async ({ database, command, query, commandJson, connectionId }) => {
    const mongoCommand = parseMongoCommand(command, query, commandJson);
    const commandType = classifyMongoCommand(mongoCommand);
    if (readOnly && commandType !== "read") {
      throw new Error(`Refused to execute ${commandType} MongoDB command while --readOnly is enabled.`);
    }

    const result = await manager.executeMongo(mongoCommand, database, connectionId);
    return textResult({ commandType, result });
  },
);

server.tool(
  "execute_sql",
  executeSqlDescription,
  {
    sql: z
      .string()
      .describe("Single SQL statement for PostgreSQL or MySQL. PostgreSQL uses $1, $2 placeholders; MySQL uses ? placeholders."),
    params: z.array(z.unknown()).optional().describe("Values for positional placeholders. Use this instead of string-concatenating user values into SQL."),
    connectionId: connectionIdSchema,
  },
  async ({ sql, params, connectionId }) => {
    const statementType = classifySql(sql);
    if (readOnly && statementType !== "read") {
      throw new Error(`Refused to execute ${statementType} SQL while --readOnly is enabled.`);
    }

    const result = await manager.execute(sql, params ?? [], connectionId);
    return textResult({ statementType, ...result });
  },
);

server.tool(
  "begin_transaction",
  "Begin a transaction for a connection.",
  { connectionId: connectionIdSchema },
  async ({ connectionId }) => {
    if (readOnly) {
      throw new Error("Transactions are disabled while --readOnly is enabled.");
    }

    await manager.begin(connectionId);
    return textResult({ transaction: "begun" });
  },
);

server.tool(
  "commit_transaction",
  "Commit the current transaction for a connection.",
  { connectionId: connectionIdSchema },
  async ({ connectionId }) => {
    if (readOnly) {
      throw new Error("Transactions are disabled while --readOnly is enabled.");
    }

    await manager.commit(connectionId);
    return textResult({ transaction: "committed" });
  },
);

server.tool(
  "rollback_transaction",
  "Rollback the current transaction for a connection.",
  { connectionId: connectionIdSchema },
  async ({ connectionId }) => {
    if (readOnly) {
      throw new Error("Transactions are disabled while --readOnly is enabled.");
    }

    await manager.rollback(connectionId);
    return textResult({ transaction: "rolled_back" });
  },
);

server.tool(
  "close_connection",
  "Close one connection, or the latest connection if no id is supplied.",
  { connectionId: connectionIdSchema },
  async ({ connectionId }) => {
    await manager.close(connectionId);
    return textResult({ closed: true });
  },
);

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);

async function shutdown(): Promise<void> {
  await manager.closeAll();
  process.exit(0);
}

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function classifyMongoCommand(command: Record<string, unknown>): "read" | "write" | "unknown" {
  const commandName = Object.keys(command)[0]?.toLowerCase();
  if (!commandName) {
    return "unknown";
  }

  if (commandName === "aggregate" && aggregatePipelineWrites(command.pipeline)) {
    return "write";
  }

  if (commandName === "explain") {
    return isReadonlyExplain(command.explain) ? "read" : "unknown";
  }

  const readCommands = new Set([
    "aggregate",
    "buildinfo",
    "collstats",
    "connectionstatus",
    "count",
    "dbstats",
    "distinct",
    "estimateddocumentcount",
    "find",
    "getcmdlineopts",
    "getdefaultreadconcern",
    "getlog",
    "getparameter",
    "hello",
    "hostinfo",
    "ismaster",
    "listcollections",
    "listdatabases",
    "listindexes",
    "ping",
    "serverstatus",
    "usersinfo",
    "rolesinfo",
    "whatsmyuri",
  ]);

  if (readCommands.has(commandName)) {
    return "read";
  }

  const writeCommands = new Set([
    "aborttransaction",
    "committransaction",
    "converttocapped",
    "create",
    "createindexes",
    "delete",
    "drop",
    "dropdatabase",
    "dropindexes",
    "findandmodify",
    "insert",
    "renamecollection",
    "replace",
    "update",
  ]);

  return writeCommands.has(commandName) ? "write" : "unknown";
}

function aggregatePipelineWrites(pipeline: unknown): boolean {
  return (
    Array.isArray(pipeline) &&
    pipeline.some((stage) => {
      if (!stage || typeof stage !== "object" || Array.isArray(stage)) {
        return false;
      }

      const keys = Object.keys(stage).map((key) => key.toLowerCase());
      return keys.includes("$out") || keys.includes("$merge");
    })
  );
}

function isReadonlyExplain(explain: unknown): boolean {
  return explain !== null && typeof explain === "object" && classifyMongoCommand(explain as Record<string, unknown>) === "read";
}
