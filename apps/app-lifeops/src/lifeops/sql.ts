import type { IAgentRuntime } from "@elizaos/core";

export type RawSqlQuery = {
  queryChunks: Array<{ value?: unknown }>;
};

export type RuntimeDb = {
  execute: (query: RawSqlQuery) => Promise<unknown>;
};

type RuntimeDbAdapterLike = {
  db?: RuntimeDb;
  getRawConnection?: () => unknown;
};

let cachedSqlRaw: ((query: string) => RawSqlQuery) | null = null;

export function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function toText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

export function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") {
    if (typeof value === "object") return value as T;
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue<Record<string, unknown> | null>(value, null);
  return asObject(parsed) ?? {};
}

export function parseJsonArray<T>(value: unknown): T[] {
  const parsed = parseJsonValue<T[] | null>(value, null);
  return Array.isArray(parsed) ? parsed : [];
}

export function extractRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result
      .map((row) => asObject(row))
      .filter((row): row is Record<string, unknown> => row !== null);
  }
  const object = asObject(result);
  if (!object) return [];
  const rows = object.rows;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => asObject(row))
    .filter((row): row is Record<string, unknown> => row !== null);
}

export async function getSqlRaw(): Promise<(query: string) => RawSqlQuery> {
  if (cachedSqlRaw) return cachedSqlRaw;
  const drizzle = (await import("drizzle-orm")) as {
    sql: { raw: (query: string) => RawSqlQuery };
  };
  cachedSqlRaw = drizzle.sql.raw;
  return cachedSqlRaw;
}

function getRuntimeDbAdapter(runtime: IAgentRuntime): RuntimeDbAdapterLike {
  const runtimeLike = runtime as IAgentRuntime & {
    adapter?: RuntimeDbAdapterLike;
    databaseAdapter?: RuntimeDbAdapterLike;
  };
  const adapter =
    runtimeLike.adapter?.db &&
    typeof runtimeLike.adapter.db.execute === "function"
      ? runtimeLike.adapter
      : runtimeLike.databaseAdapter?.db &&
          typeof runtimeLike.databaseAdapter.db.execute === "function"
        ? runtimeLike.databaseAdapter
        : null;
  if (!adapter) {
    throw new Error("runtime database adapter unavailable");
  }
  return adapter;
}

export function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb {
  const db = getRuntimeDbAdapter(runtime).db;
  if (!db || typeof db.execute !== "function") {
    throw new Error("runtime database adapter unavailable");
  }
  return db;
}

export function getRuntimeDbCacheKey(runtime: IAgentRuntime): object {
  const adapter = getRuntimeDbAdapter(runtime);
  const rawConnection =
    typeof adapter.getRawConnection === "function"
      ? adapter.getRawConnection()
      : null;
  if (
    rawConnection &&
    (typeof rawConnection === "object" || typeof rawConnection === "function")
  ) {
    return rawConnection as object;
  }

  return getRuntimeDb(runtime) as unknown as object;
}

export async function executeRawSql(
  runtime: IAgentRuntime,
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await getSqlRaw();
  const db = getRuntimeDb(runtime);
  const result = await db.execute(raw(sqlText));
  return extractRows(result);
}

function collectErrorMessages(error: unknown): string[] {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      break;
    }

    if (current instanceof Error) {
      if (current.message) messages.push(current.message);
      if (current.stack) messages.push(current.stack);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }

    if (typeof current === "object") {
      const maybeError = current as { message?: unknown; cause?: unknown };
      if (typeof maybeError.message === "string" && maybeError.message) {
        messages.push(maybeError.message);
      }
      if (maybeError.cause !== undefined) {
        current = maybeError.cause;
        continue;
      }
    }

    break;
  }

  return messages;
}

export function isLifeOpsBootstrapQueryError(error: unknown): boolean {
  const haystack = collectErrorMessages(error).join("\n").toLowerCase();
  if (!haystack.includes("failed query:")) {
    return false;
  }

  return (
    haystack.includes("create table if not exists life_") ||
    haystack.includes("create index if not exists idx_life_") ||
    haystack.includes("alter table life_")
  );
}

export function isRetryableLifeOpsStorageError(error: unknown): boolean {
  const haystack = collectErrorMessages(error).join("\n").toLowerCase();
  if (!haystack) {
    return false;
  }

  if (isLifeOpsBootstrapQueryError(error)) {
    return true;
  }

  const hasStorageSignal = [
    "aborted(). build with -sassertions",
    "database disk image is malformed",
    "file is not a database",
    "malformed database schema",
    "database is locked",
    "lock file already exists",
    "wal file",
    "checkpoint failed",
    "checksum mismatch",
    "corrupt",
  ].some((needle) => haystack.includes(needle));
  const hasBackendSignal =
    haystack.includes("pglite") ||
    haystack.includes("sqlite") ||
    haystack.includes("failed query:");

  return hasStorageSignal && hasBackendSignal;
}

export async function listTableColumns(
  runtime: IAgentRuntime,
  tableName: string,
): Promise<string[]> {
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ${sqlQuote(tableName)}
        ORDER BY ordinal_position`,
    );
    if (rows.length > 0) {
      return rows
        .map((row) => toText(row.column_name))
        .filter((name) => name.length > 0);
    }
  } catch (error) {
    const message = String(error).toLowerCase();
    const infoSchemaUnavailable =
      message.includes("information_schema") ||
      message.includes("no such table") ||
      message.includes("does not exist") ||
      message.includes("syntax error") ||
      message.includes("unknown table") ||
      message.includes("relation") ||
      message.includes("pragma");
    if (!infoSchemaUnavailable) {
      throw error;
    }
  }

  if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
    throw new Error(`invalid table name for PRAGMA: ${tableName}`);
  }
  const rows = await executeRawSql(runtime, `PRAGMA table_info(${tableName})`);
  return rows.map((row) => toText(row.name)).filter((name) => name.length > 0);
}

export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  return sqlQuote(value);
}

export function sqlInteger(value: number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (!Number.isFinite(value)) throw new Error("invalid numeric SQL literal");
  return String(Math.trunc(value));
}

export function sqlNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (!Number.isFinite(value)) throw new Error("invalid numeric SQL literal");
  return String(value);
}

export function sqlBoolean(value: boolean): string {
  return value ? "TRUE" : "FALSE";
}

export function sqlJson(value: unknown): string {
  return sqlQuote(JSON.stringify(value ?? null));
}
