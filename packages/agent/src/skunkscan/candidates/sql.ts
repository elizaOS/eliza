/**
 * Self-contained raw-SQL helpers for the scam_pattern_candidates table.
 * Mirrors services/approval/sql.ts's shape, but takes a bare `RuntimeDb`
 * (`{ execute }`) rather than a full `IAgentRuntime` - this store needs to
 * be usable both from a live pipeline analyzer (which has
 * `runtime.adapter.db`) and from a standalone script/test with no full
 * agent runtime booted (via @elizaos/plugin-sql's `createDatabaseAdapter`
 * + `getDb()`), so it's narrowed to exactly what it needs.
 */

type RawSqlQuery = {
  queryChunks: Array<{ value?: unknown }>;
};

export type RuntimeDb = {
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
      `[ScamPatternCandidatesSql] Expected JSON string or object, received ${typeof value}`,
    );
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[ScamPatternCandidatesSql] Invalid JSON value: ${message}`);
  }
}

export function parseJsonArray<T>(value: unknown): T[] {
  const parsed = parseJsonValue<unknown>(value, []);
  if (!Array.isArray(parsed)) {
    throw new Error("[ScamPatternCandidatesSql] Expected JSON array");
  }
  return parsed as T[];
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isMissingJsonValue(value)) return {};
  const parsed = parseJsonValue<Record<string, unknown> | null>(value, null);
  const object = asObject(parsed);
  if (object) return object;
  throw new Error("[ScamPatternCandidatesSql] Expected JSON object");
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

export async function executeRawSql(
  db: RuntimeDb,
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await getSqlRaw();
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

export function sqlBoolean(value: boolean): string {
  return value ? "TRUE" : "FALSE";
}

export function sqlInteger(value: number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (!Number.isFinite(value)) throw new Error("invalid numeric SQL literal");
  return String(Math.trunc(value));
}

export function sqlJson(value: unknown): string {
  return sqlQuote(JSON.stringify(value ?? null));
}
