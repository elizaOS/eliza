/**
 * Adapts the Core raw-SQL boundary to finance repositories while retaining
 * finance-owned transactions and optimistic concurrency behavior.
 */
import {
  asRawSqlRecord,
  coerceRawSqlBoolean,
  coerceRawSqlNumber,
  coerceRawSqlText,
  executeRawSqlOnDb,
  executeRuntimeRawSql,
  getRuntimeRawSqlDb,
  type IAgentRuntime,
  parseRawSqlJsonArray,
  parseRawSqlJsonRecord,
  type RawSqlQuery,
  type RuntimeRawSqlDb,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
} from "@elizaos/core";

const options = { subsystem: "FinancesSql" } as const;

export type { RawSqlQuery };
export type RuntimeDb = RuntimeRawSqlDb;
export type TransactionalDb = RuntimeDb;
type DrizzleTransactionalDb = RuntimeDb & {
  transaction?: <T>(fn: (tx: TransactionalDb) => Promise<T>) => Promise<T>;
};

export {
  asRawSqlRecord as asObject,
  coerceRawSqlBoolean as toBoolean,
  coerceRawSqlNumber as toNumber,
  coerceRawSqlText as toText,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
};

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  return parseRawSqlJsonRecord(value, options);
}

export function parseJsonArray<T>(value: unknown): T[] {
  return parseRawSqlJsonArray<T>(value, options);
}

export function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb {
  return getRuntimeRawSqlDb(runtime, options);
}

export function executeRawSql(
  runtime: IAgentRuntime,
  sqlTextValue: string,
): Promise<Array<Record<string, unknown>>> {
  return executeRuntimeRawSql(runtime, sqlTextValue, options);
}

export function executeRawSqlTx(
  tx: TransactionalDb,
  sqlTextValue: string,
): Promise<Array<Record<string, unknown>>> {
  return executeRawSqlOnDb(tx, sqlTextValue, options);
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

export async function withTransaction<T>(
  runtime: IAgentRuntime,
  fn: (tx: TransactionalDb) => Promise<T>,
): Promise<T> {
  const db = getRuntimeDb(runtime) as DrizzleTransactionalDb;
  if (typeof db.transaction === "function") {
    return db.transaction(async (tx) => fn(tx));
  }
  return fn({ execute: (query) => db.execute(query) });
}

export async function withOptimisticRetry<T>(
  fn: () => Promise<T>,
  optionsValue?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<T> {
  const maxAttempts = Math.max(1, optionsValue?.maxAttempts ?? 3);
  const baseDelay = Math.max(1, optionsValue?.baseDelayMs ?? 20);
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof OptimisticLockError)) throw error;
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
