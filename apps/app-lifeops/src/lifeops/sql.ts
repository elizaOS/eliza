import type { IAgentRuntime } from "@elizaos/core";

export type RawSqlQuery = {
  queryChunks: Array<{ value?: unknown }>;
};

export type RuntimeDb = {
  execute: (query: RawSqlQuery) => Promise<unknown>;
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

function isMissingJsonValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

export function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (isMissingJsonValue(value)) return fallback;
  if (typeof value !== "string") {
    if (typeof value === "object") return value as T;
    throw new Error(
      `[LifeOpsSql] Expected JSON string or object, received ${typeof value}`,
    );
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[LifeOpsSql] Invalid JSON value: ${message}`);
  }
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isMissingJsonValue(value)) return {};
  const parsed = parseJsonValue<Record<string, unknown> | null>(value, null);
  const object = asObject(parsed);
  if (object) return object;
  throw new Error("[LifeOpsSql] Expected JSON object");
}

export function parseJsonArray<T>(value: unknown): T[] {
  if (isMissingJsonValue(value)) return [];
  const parsed = parseJsonValue<T[] | null>(value, null);
  if (Array.isArray(parsed)) return parsed;
  throw new Error("[LifeOpsSql] Expected JSON array");
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

async function getSqlRaw(): Promise<(query: string) => RawSqlQuery> {
  if (cachedSqlRaw) return cachedSqlRaw;
  const drizzle = (await import("drizzle-orm")) as {
    sql: { raw: (query: string) => RawSqlQuery };
  };
  cachedSqlRaw = drizzle.sql.raw;
  return cachedSqlRaw;
}

export function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb {
  const db = runtime.adapter?.db as RuntimeDb | undefined;
  if (!db || typeof db.execute !== "function") {
    throw new Error("runtime database adapter unavailable");
  }
  return db;
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

// ---------------------------------------------------------------------------
// SQL value encoders
// ---------------------------------------------------------------------------

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
