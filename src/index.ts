#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ConnectionManager } from "./db.js";
import { classifySql } from "./sqlClassifier.js";

const readOnly = process.argv.includes("--readOnly") || process.argv.includes("--readonly");
const manager = new ConnectionManager();

const server = new McpServer({
  name: "db-mcp",
  version: "0.1.0",
});

const connectionIdSchema = z.string().optional().describe("Connection id. Defaults to the latest connection.");

server.tool(
  "connect",
  "Open or replace a dynamic PostgreSQL/MySQL connection.",
  {
    id: z.string().optional().describe("Optional connection id. Defaults to 'default'."),
    type: z.enum(["postgres", "mysql"]),
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
  "execute_sql",
  "Execute SQL with optional positional parameters. In --readOnly mode, write/unknown SQL is rejected.",
  {
    sql: z.string(),
    params: z.array(z.unknown()).optional(),
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
