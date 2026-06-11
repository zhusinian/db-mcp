import mysql from "mysql2/promise";
import type { ConnectionOptions } from "mysql2";
import pg from "pg";

export type DatabaseType = "postgres" | "mysql";

export type ConnectionConfig = {
  id?: string;
  type: DatabaseType;
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
};

export type QueryResult = {
  rows: unknown[];
  fields: string[];
  rowCount: number;
};

type PgHandle = {
  type: "postgres";
  client: pg.Client;
  inTransaction: boolean;
};

type MysqlHandle = {
  type: "mysql";
  client: mysql.Connection;
  inTransaction: boolean;
};

type ConnectionHandle = PgHandle | MysqlHandle;

type MysqlExecuteValue = string | number | bigint | boolean | Date | null | Buffer | Uint8Array;

export class ConnectionManager {
  private readonly connections = new Map<string, ConnectionHandle>();
  private defaultConnectionId: string | null = null;

  async connect(config: ConnectionConfig): Promise<{ id: string; type: DatabaseType }> {
    const id = config.id ?? "default";
    await this.close(id);

    const handle = await createConnection(config);
    this.connections.set(id, handle);
    this.defaultConnectionId = id;

    return { id, type: config.type };
  }

  async execute(sql: string, params: unknown[] = [], connectionId?: string): Promise<QueryResult> {
    const handle = this.getConnection(connectionId);

    if (handle.type === "postgres") {
      const result = await handle.client.query(sql, params);
      return {
        rows: result.rows,
        fields: result.fields.map((field) => field.name),
        rowCount: result.rowCount ?? result.rows.length,
      };
    }

    const [rows, fields] = await handle.client.execute(sql, params as MysqlExecuteValue[]);
    return {
      rows: Array.isArray(rows) ? rows : [],
      fields: Array.isArray(fields) ? fields.map((field) => field.name) : [],
      rowCount: getMysqlRowCount(rows),
    };
  }

  async begin(connectionId?: string): Promise<void> {
    const handle = this.getConnection(connectionId);
    if (handle.inTransaction) {
      throw new Error("Transaction is already open for this connection.");
    }

    await this.execute("BEGIN", [], connectionId);
    handle.inTransaction = true;
  }

  async commit(connectionId?: string): Promise<void> {
    const handle = this.getConnection(connectionId);
    if (!handle.inTransaction) {
      throw new Error("No transaction is open for this connection.");
    }

    await this.execute("COMMIT", [], connectionId);
    handle.inTransaction = false;
  }

  async rollback(connectionId?: string): Promise<void> {
    const handle = this.getConnection(connectionId);
    if (!handle.inTransaction) {
      throw new Error("No transaction is open for this connection.");
    }

    await this.execute("ROLLBACK", [], connectionId);
    handle.inTransaction = false;
  }

  async close(connectionId?: string): Promise<void> {
    const id = connectionId ?? this.defaultConnectionId;
    if (!id) {
      return;
    }

    const handle = this.connections.get(id);
    if (!handle) {
      return;
    }

    if (handle.type === "postgres") {
      await handle.client.end();
    } else {
      await handle.client.end();
    }

    this.connections.delete(id);
    if (this.defaultConnectionId === id) {
      this.defaultConnectionId = this.connections.keys().next().value ?? null;
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.close(id)));
  }

  private getConnection(connectionId?: string): ConnectionHandle {
    const id = connectionId ?? this.defaultConnectionId;
    if (!id) {
      throw new Error("No database connection is open. Call connect first.");
    }

    const handle = this.connections.get(id);
    if (!handle) {
      throw new Error(`Unknown database connection: ${id}`);
    }

    return handle;
  }
}

async function createConnection(config: ConnectionConfig): Promise<ConnectionHandle> {
  if (config.type === "postgres") {
    const client = new pg.Client(
      config.connectionString
        ? { connectionString: config.connectionString, ssl: config.ssl }
        : {
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
            password: config.password,
            ssl: config.ssl,
          },
    );
    await client.connect();
    return { type: "postgres", client, inTransaction: false };
  }

  const client = config.connectionString
    ? await mysql.createConnection(config.connectionString)
    : await mysql.createConnection({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.ssl ? {} : undefined,
      } satisfies ConnectionOptions);
  return { type: "mysql", client, inTransaction: false };
}

function getMysqlRowCount(rows: unknown): number {
  if (Array.isArray(rows)) {
    return rows.length;
  }

  if (rows && typeof rows === "object" && "affectedRows" in rows) {
    const affectedRows = (rows as { affectedRows?: unknown }).affectedRows;
    return typeof affectedRows === "number" ? affectedRows : 0;
  }

  return 0;
}
