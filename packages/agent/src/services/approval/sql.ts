/**
 * Self-contained raw-SQL helpers for the runtime approval queue.
 *
 * The approval store issues raw SQL against the agent's database adapter over
 * the `approval_requests` table owned by `@elizaos/plugin-sql` (public schema).
 * This is the minimal subset of encoders/parsers/runners the store needs; it is
 * intentionally local to `@elizaos/agent` so the runtime approval queue carries
 * no dependency on plugin-side SQL glue. Mirrors `knowledge-graph/sql.ts`.
 */

import type { IAgentRuntime } from "@elizaos/core";

type RawSqlQuery = {
  queryChunks: Array<{ value?: unknown }>;
};

type RuntimeDb = {
  execute: (query: RawSqlQuery) => Promise<unknown>;
};

let cachedSqlRaw: ((query: string) => RawSqlQuery) | null = null;

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function toText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function isMissingJsonValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (isMissingJsonValue(value)) return fallback;
  if (typeof value !== "string") {
    if (typeof value === "object") return value as T;
    throw new Error(
      `[ApprovalSql] Expected JSON string or object, received ${typeof value}`,
    );
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[ApprovalSql] Invalid JSON value: ${message}`);
  }
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isMissingJsonValue(value)) return {};
  const parsed = parseJsonValue<Record<string, unknown> | null>(value, null);
  const object = asObject(parsed);
  if (object) return object;
  throw new Error("[ApprovalSql] Expected JSON object");
}

function extractRows(result: unknown): Array<Record<string, unknown>> {
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

function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb {
  const db = runtime.adapter.db as RuntimeDb | undefined;
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

export function sqlJson(value: unknown): string {
  return sqlQuote(JSON.stringify(value ?? null));
}
