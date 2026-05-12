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
// Transactions and optimistic concurrency
//
// Atomic multi-step operations (e.g., thread merge: update target + mark N
// source threads stopped + append events) MUST run inside `withTransaction`.
// Without it, a crash mid-loop leaves dangling state — half-merged threads,
// scheduled tasks fired but not dispatched, etc.
//
// `withTransaction` opens a PostgreSQL transaction via the underlying drizzle
// adapter and exposes a `TransactionalDb` handle with the same `.execute(raw)`
// shape as the global runtime DB. Pass it into transaction-aware variants of
// `executeRawSql`/repository methods (currently named `executeRawSqlTx`).
//
// `OptimisticLockError` is thrown when an UPDATE with a version check affects
// 0 rows — caller catches once, re-reads fresh, retries (3x max, with
// exponential backoff), then surfaces the conflict.
// ---------------------------------------------------------------------------

export type TransactionalDb = {
  execute: (query: RawSqlQuery) => Promise<unknown>;
};

type DrizzleTransactionalDb = RuntimeDb & {
  transaction?: <T>(fn: (tx: TransactionalDb) => Promise<T>) => Promise<T>;
};

export class OptimisticLockError extends Error {
  readonly code = "OPTIMISTIC_LOCK_ERROR";
  readonly table: string;
  readonly id: string;
  readonly expectedVersion: number;
  constructor(args: { table: string; id: string; expectedVersion: number }) {
    super(
      `Optimistic lock conflict on ${args.table} id=${args.id} expectedVersion=${args.expectedVersion}`,
    );
    this.table = args.table;
    this.id = args.id;
    this.expectedVersion = args.expectedVersion;
  }
}

/**
 * Run `fn` inside a database transaction. The handle passed to `fn` exposes
 * the same `.execute(raw)` shape as the global runtime DB, but every call
 * goes through the transaction. Throwing rolls back; returning commits.
 *
 * Drizzle's pg adapter supports `db.transaction(fn)` natively. If the adapter
 * does not (e.g., a test fake), we fall back to running `fn` against the
 * global DB and warn — atomicity is not guaranteed in that mode.
 */
export async function withTransaction<T>(
  runtime: IAgentRuntime,
  fn: (tx: TransactionalDb) => Promise<T>,
): Promise<T> {
  const db = getRuntimeDb(runtime) as DrizzleTransactionalDb;
  if (typeof db.transaction === "function") {
    return await db.transaction(async (tx) => fn(tx));
  }
  // Adapter does not support transactions (likely a test fake). Run inline.
  return await fn({
    execute: (query) => db.execute(query),
  });
}

/**
 * Transactional analogue of `executeRawSql`. Pass the `tx` handed in by
 * `withTransaction`'s callback — every statement participates in the same
 * transaction and commits/rolls back together.
 */
export async function executeRawSqlTx(
  tx: TransactionalDb,
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await getSqlRaw();
  const result = await tx.execute(raw(sqlText));
  return extractRows(result);
}

/**
 * Retry policy for optimistic-lock conflicts. Default: 3 attempts with
 * exponential backoff at 20ms / 50ms / 120ms. After 3 attempts the original
 * `OptimisticLockError` is rethrown.
 */
export async function withOptimisticRetry<T>(
  fn: () => Promise<T>,
  options?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<T> {
  const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
  const baseDelay = Math.max(1, options?.baseDelayMs ?? 20);
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof OptimisticLockError)) {
        throw error;
      }
      lastError = error;
      if (attempt < maxAttempts - 1) {
        const delay =
          baseDelay * 2 ** attempt + Math.floor(Math.random() * baseDelay);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
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
