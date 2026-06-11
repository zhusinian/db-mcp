export type SqlStatementType = "read" | "write" | "transaction" | "unknown";

const READ_KEYWORDS = new Set([
  "select",
  "show",
  "describe",
  "desc",
  "explain",
  "values",
]);

const WRITE_KEYWORDS = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "replace",
  "create",
  "alter",
  "drop",
  "truncate",
  "grant",
  "revoke",
  "call",
  "do",
  "copy",
  "load",
  "set",
  "reset",
  "analyze",
  "vacuum",
  "refresh",
]);

const TRANSACTION_KEYWORDS = new Set([
  "begin",
  "start",
  "commit",
  "rollback",
  "savepoint",
  "release",
]);

export function classifySql(sql: string): SqlStatementType {
  const firstKeyword = getFirstKeyword(sql);

  if (!firstKeyword) {
    return "unknown";
  }

  if (firstKeyword === "with") {
    return containsWriteKeyword(sql) ? "write" : "read";
  }

  if (firstKeyword === "select" && isMutatingSelect(sql)) {
    return "write";
  }

  if (READ_KEYWORDS.has(firstKeyword)) {
    return "read";
  }

  if (WRITE_KEYWORDS.has(firstKeyword)) {
    return "write";
  }

  if (TRANSACTION_KEYWORDS.has(firstKeyword)) {
    return "transaction";
  }

  return "unknown";
}

function containsWriteKeyword(sql: string): boolean {
  for (const token of getKeywords(sql)) {
    if (WRITE_KEYWORDS.has(token)) {
      return true;
    }
  }

  return false;
}

function isMutatingSelect(sql: string): boolean {
  const keywords = getKeywords(sql);
  for (let i = 0; i < keywords.length; i += 1) {
    if (keywords[i] === "for" && ["update", "share"].includes(keywords[i + 1] ?? "")) {
      return true;
    }

    if (keywords[i] === "into") {
      return true;
    }
  }

  return false;
}

function getKeywords(sql: string): string[] {
  return stripCommentsAndQuotedText(sql)
    .match(/[a-zA-Z_][a-zA-Z0-9_]*/g)
    ?.map((token) => token.toLowerCase()) ?? [];
}

function stripCommentsAndQuotedText(sql: string): string {
  return sql
    .replace(/--.*(?=\n|$)/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, " ")
    .replace(/"(?:""|[^"])*"/g, " ")
    .replace(/`(?:``|[^`])*`/g, " ");
}

function getFirstKeyword(sql: string): string | null {
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }

    const match = sql.slice(i).match(/^[a-zA-Z_][a-zA-Z0-9_]*/);
    return match ? match[0].toLowerCase() : null;
  }

  return null;
}
