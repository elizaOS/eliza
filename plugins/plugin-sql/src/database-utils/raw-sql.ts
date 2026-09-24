/**
 * Shared raw-SQL execution, row validation and value encoders for domain stores.
 * Accepts complete row arrays or PostgreSQL-style result envelopes, including
 * empty rows from DDL. Invalid rows fail as a whole rather than disappearing.
 * Runtime lookup and transaction requirements remain with each domain owner.
 */
import type { SQL } from "drizzle-orm";

export type RawSqlQuery = SQL;
export type RuntimeDb = { execute(query: RawSqlQuery): Promise<unknown> };
export type TransactionalDb = RuntimeDb;

/** Structured boundary error kept independent of the core runtime. */
export class RawSqlError extends Error {
  override readonly name = "RawSqlError";
  constructor(
    readonly code:
      | "SQL_RESULT_INVALID"
      | "SQL_JSON_INVALID"
      | "SQL_VALUE_INVALID",
    message: string,
    options: ErrorOptions & { rowIndex?: number } = {},
  ) {
    super(message, options);
    this.context =
      options.rowIndex === undefined
        ? undefined
        : { rowIndex: options.rowIndex };
  }
  readonly context: { rowIndex: number } | undefined;
}

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
    throw new RawSqlError(
      "SQL_JSON_INVALID",
      `Expected JSON string or object, received ${typeof value}`,
    );
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    // error-policy:J3 Invalid persisted JSON is rejected with its parse cause.
    throw new RawSqlError("SQL_JSON_INVALID", "Invalid SQL JSON value", {
      cause: error,
    });
  }
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (isMissingJsonValue(value)) return {};
  const parsed = parseJsonValue<Record<string, unknown> | null>(value, null);
  const object = asObject(parsed);
  if (object) return object;
  throw new RawSqlError("SQL_JSON_INVALID", "Expected SQL JSON object");
}

export function parseJsonArray<T>(value: unknown): T[] {
  if (isMissingJsonValue(value)) return [];
  const parsed = parseJsonValue<T[] | null>(value, null);
  if (Array.isArray(parsed)) return parsed;
  throw new RawSqlError("SQL_JSON_INVALID", "Expected SQL JSON array");
}

export function extractRows(result: unknown): Array<Record<string, unknown>> {
  const rows = Array.isArray(result) ? result : asObject(result)?.rows;
  if (!Array.isArray(rows)) {
    throw new RawSqlError(
      "SQL_RESULT_INVALID",
      "Database execution did not return a row array",
    );
  }
  return Array.from(rows, (row, rowIndex) => {
    const object = asObject(row);
    if (!object) {
      throw new RawSqlError(
        "SQL_RESULT_INVALID",
        "Database execution returned an invalid row",
        { rowIndex },
      );
    }
    return object;
  });
}

export async function executeSql(
  db: RuntimeDb,
  statement: string,
): Promise<Array<Record<string, unknown>>> {
  const { sql } = await import("drizzle-orm");
  return extractRows(await db.execute(sql.raw(statement)));
}

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
 * Retry optimistic conflicts with exponential backoff and random jitter.
 * Defaults to three attempts and a 20ms base; other errors propagate immediately.
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
      // error-policy:J4 Only an explicit optimistic conflict is retryable.
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

export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function sqlText(value: string | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  return sqlQuote(value);
}

export function sqlInteger(value: number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (!Number.isFinite(value))
    throw new RawSqlError("SQL_VALUE_INVALID", "Invalid numeric SQL literal");
  return String(Math.trunc(value));
}

export function sqlNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (!Number.isFinite(value))
    throw new RawSqlError("SQL_VALUE_INVALID", "Invalid numeric SQL literal");
  return String(value);
}

export function sqlBoolean(value: boolean): string {
  return value ? "TRUE" : "FALSE";
}

export function sqlJson(value: unknown): string {
  return sqlQuote(JSON.stringify(value ?? null));
}
