# db-mcp

一个轻量级 MCP（Model Context Protocol）数据库服务器。它通过 stdio 与 MCP 客户端通信，支持在运行时动态打开 PostgreSQL、MySQL 和 MongoDB 连接，并执行 SQL 或 MongoDB command。

## 特性

- 动态连接：内置 `connect` 工具，可在会话中按需创建或替换 PostgreSQL / MySQL / MongoDB 连接。
- 执行 SQL：`execute_sql` 工具支持位置化参数绑定，避免拼接注入。
- 执行 MongoDB command：`execute_mongodb` 接收通用 command 文档或 `query` Extended JSON 字符串，不限制为固定 CRUD 方法。
- 事务控制：提供 `begin_transaction`、`commit_transaction`、`rollback_transaction` 三个工具。
- 关闭连接：`close_connection` 用于主动释放指定或当前连接。
- 只读模式：支持 `--readOnly` / `--readonly` 启动参数。
- 自动识别 SQL 类型：读（read）、写（write）、事务（transaction）、未知（unknown）。
- 只读模式仅放行 `read` 类型，write、transaction、unknown 全部拒绝；MongoDB aggregate 中包含 `$out` / `$merge` 时按写操作处理。

## 安装

环境要求：Node.js 20+。

```bash
npm install
npm run build
```

## 运行

默认启动（可写）：

```bash
npx db-mcp
```

只读模式：

```bash
npx db-mcp --readOnly
```

开发模式（tsx 直接执行源码）：

```bash
npm run dev -- --readOnly
```

## 在 MCP 客户端中配置

在客户端的 MCP 配置中新增一个 server 条目即可。

```json
{
  "mcpServers": {
    "db-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/db-mcp/dist/index.js", "--readOnly"]
    }
  }
}
```

如果不启用只读模式，去掉 `--readOnly` 即可。

## 工具列表

| 工具 | 说明 |
| --- | --- |
| `connect` | 创建或替换一个动态数据库连接 |
| `execute_sql` | 执行 SQL 语句，支持位置化参数 |
| `execute_mongodb` | 执行 MongoDB command 文档或 `query` Extended JSON 字符串 |
| `begin_transaction` | 开启一个事务 |
| `commit_transaction` | 提交当前事务 |
| `rollback_transaction` | 回滚当前事务 |
| `close_connection` | 关闭指定连接或当前连接 |

`connectionId` 参数在所有工具中都是可选的：不传时使用最近一次 `connect` 创建的连接。

这些工具的 MCP 描述中内置了面向客户端 AI 的使用提示。客户端 AI 会看到各工具的 description 和参数 schema description，用于决定应该生成 SQL、MongoDB command 对象，还是 Extended JSON 查询字符串。

## 工具详解

### connect

创建一个新连接，或在 id 冲突时替换已有连接。`id` 不传时默认为 `default`。

PostgreSQL 示例（使用连接字符串）：

```json
{
  "id": "analytics",
  "type": "postgres",
  "connectionString": "postgres://user:password@localhost:5432/app"
}
```

PostgreSQL 示例（使用离散字段）：

```json
{
  "id": "app_pg",
  "type": "postgres",
  "host": "localhost",
  "port": 5432,
  "database": "app",
  "user": "app",
  "password": "secret",
  "ssl": false
}
```

MySQL 示例：

```json
{
  "id": "app_mysql",
  "type": "mysql",
  "host": "localhost",
  "port": 3306,
  "database": "app",
  "user": "root",
  "password": "secret"
}
```

MongoDB 示例（使用连接字符串）：

```json
{
  "id": "app_mongo",
  "type": "mongodb",
  "connectionString": "mongodb://user:password@localhost:27017/app",
  "database": "app"
}
```

MongoDB 示例（使用离散字段）：

```json
{
  "id": "app_mongo",
  "type": "mongodb",
  "host": "localhost",
  "port": 27017,
  "database": "app",
  "user": "root",
  "password": "secret",
  "ssl": false
}
```

### execute_sql

执行单条 SQL，并支持位置化参数。参数占位符与底层驱动一致：

- PostgreSQL 使用 `$1`、`$2` …
- MySQL 使用 `?`

内置提示会要求客户端 AI：

- 生成普通 SQL，不生成 MongoDB 语法。
- 使用 `params` 绑定参数，不把用户输入拼接进 SQL 字符串。
- PostgreSQL 使用 `$1`、`$2` 等占位符。
- MySQL 使用 `?` 占位符。
- 只读模式下只生成读查询。

PostgreSQL 示例：

```json
{
  "connectionId": "analytics",
  "sql": "select id, email from users where id = $1",
  "params": [1]
}
```

MySQL 示例：

```json
{
  "connectionId": "app_mysql",
  "sql": "select id, email from users where id = ?",
  "params": [1]
}
```

返回结构示例：

```json
{
  "statementType": "read",
  "rows": [{ "id": 1, "email": "a@example.com" }],
  "fields": ["id", "email"],
  "rowCount": 1
}
```

### execute_mongodb

执行 MongoDB 原生命令。`command`、`query`、`commandJson` 三选一：

- `command`：直接传 JSON 对象。
- `query`：传 Extended JSON 字符串，适合让 AI 直接生成完整 MongoDB command 查询语句。
- `commandJson`：`query` 的兼容别名，适合 `$oid`、`$date` 等 BSON 类型。

内置提示会要求客户端 AI：

- 使用 MongoDB command，不生成 `db.users.find(...)` 这类 Mongo shell JavaScript。
- 查询字符串必须是合法 Extended JSON。
- `find` 使用 `{"find":"users","filter":{},"limit":10}` 这类 command。
- `aggregate` 使用 `{"aggregate":"orders","pipeline":[...],"cursor":{}}`，并包含 `cursor`。
- `_id`、日期等 BSON 值使用 `$oid`、`$date` 等 Extended JSON。
- 只读模式下避免写命令，且不要使用包含 `$out` / `$merge` 的聚合。

查询示例：

```json
{
  "connectionId": "app_mongo",
  "database": "app",
  "command": {
    "find": "users",
    "filter": { "active": true },
    "limit": 10
  }
}
```

聚合示例：

```json
{
  "connectionId": "app_mongo",
  "database": "app",
  "command": {
    "aggregate": "orders",
    "pipeline": [
      { "$match": { "status": "paid" } },
      { "$group": { "_id": "$userId", "total": { "$sum": "$amount" } } }
    ],
    "cursor": {}
  }
}
```

Extended JSON 示例：

```json
{
  "connectionId": "app_mongo",
  "database": "app",
  "query": "{\"find\":\"users\",\"filter\":{\"_id\":{\"$oid\":\"66f000000000000000000001\"}},\"limit\":1}"
}
```

写入也通过同一个工具传 MongoDB command：

```json
{
  "connectionId": "app_mongo",
  "database": "app",
  "command": {
    "insert": "users",
    "documents": [{ "email": "a@example.com", "active": true }]
  }
}
```

只读模式下会拒绝明确写操作和未知命令；`aggregate` 管道包含 `$out` 或 `$merge` 时也会被拒绝。

### 事务控制

`begin_transaction`、`commit_transaction`、`rollback_transaction` 的入参一致，仅支持 PostgreSQL / MySQL 连接：

```json
{ "connectionId": "analytics" }
```

调用顺序示例：先 `begin_transaction`，再连续 `execute_sql` 执行若干写语句，最后根据结果调用 `commit_transaction` 或 `rollback_transaction`。

注意：

- 一个连接同一时间只能存在一个事务，重复开启会报错。
- 只读模式下，三个事务工具都会被拒绝。
- 进程退出时会自动关闭所有连接。

### close_connection

关闭指定连接；不传 `connectionId` 时关闭当前默认连接。

```json
{ "connectionId": "analytics" }
```

## SQL 类型识别

服务器会跳过空白、`--` 行注释、`/* ... */` 块注释以及引号/反引号包裹的字符串，再判断第一个关键字：

- 读（read）：`select`、`show`、`describe`、`desc`、`explain`、`values`，以及不包含写关键字的 `with` 查询。
- 写（write）：`insert`、`update`、`delete`、`merge`、`replace`、`create`、`alter`、`drop`、`truncate`、`grant`、`revoke`、`call`、`do`、`copy`、`load`、`set`、`reset`、`analyze`、`vacuum`、`refresh`。
- 事务（transaction）：`begin`、`start`、`commit`、`rollback`、`savepoint`、`release`。
- 未知（unknown）：以上均不匹配，例如以 `@`、变量、方言特有语法开头的语句。

补充规则：

- `with` 查询中若出现写关键字（`insert` / `update` / `delete` / `merge` / `replace` 等），按写处理。
- `select ... for update`、`select ... for share`、`select ... into ...` 等具有副作用的形态，按写处理。
- 只读模式下仅放行 `read` 类型。

## MongoDB command 类型识别

`execute_mongodb` 通过 command 文档的第一个键判断操作类型：

- 读（read）：例如 `find`、`aggregate`、`count`、`distinct`、`listCollections`、`listIndexes`、`dbStats`、`collStats`、`serverStatus`、`ping`。
- 写（write）：例如 `insert`、`update`、`delete`、`findAndModify`、`create`、`drop`、`createIndexes`、`dropIndexes`、`renameCollection`。
- 未知（unknown）：不在内置列表中的命令。
- `aggregate` 管道中包含 `$out` 或 `$merge` 时按写操作处理。
- `explain` 只有包裹的命令可判定为读操作时才按读处理。

## 常见问题

- 启动报错 “No database connection is open”：先调用 `connect` 成功建立连接再执行 SQL。
- 执行写语句被拒绝：检查是否在只读模式下；可在 MCP 启动参数中移除 `--readOnly`。
- MongoDB 命令被判定为 unknown：只读模式下未知命令会被拒绝；可改用明确的 read command，或在可写模式下执行。
- 事务相关报错 “No transaction is open”：只有调用过 `begin_transaction` 后才能 `commit` / `rollback`。
- 关闭进程后连接未释放：通常不需要关心；如果长时间持有连接，建议在每次会话结束前调用 `close_connection`。

## 开发

```bash
npm run dev      # 监听源码变更并以 tsx 执行
npm run build    # 类型检查并输出 dist
npm start        # 执行 dist/index.js
```

源码结构：

- `src/index.ts`：MCP server 入口、工具注册、只读模式开关。
- `src/db.ts`：连接管理、SQL 执行、MongoDB command 执行、事务控制。
- `src/sqlClassifier.ts`：SQL 类型识别。

## 许可

MIT
