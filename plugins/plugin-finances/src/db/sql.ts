/**
 * Resolves the finances runtime database and delegates common SQL primitives
 * to shared. Existing domain imports and transaction policies remain stable.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  executeSql,
  type RuntimeDb,
  type TransactionalDb,
} from "@elizaos/shared/db/raw-sql";

export {
  asObject,
  extractRows,
  OptimisticLockError,
  parseJsonArray,
  parseJsonRecord,
  parseJsonValue,
  type RawSqlQuery,
  type RuntimeDb,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  type TransactionalDb,
  toBoolean,
  toNumber,
  toText,
  withOptimisticRetry,
} from "@elizaos/shared/db/raw-sql";

export function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb {
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
  const db = getRuntimeDb(runtime);
  return executeSql(db, sqlText);
}

type DrizzleTransactionalDb = RuntimeDb & {
  transaction?: <T>(fn: (tx: TransactionalDb) => Promise<T>) => Promise<T>;
};

/**
 * Run `fn` inside a database transaction. The handle passed to `fn` exposes
 * the same `.execute(raw)` shape as the global runtime DB, but every call
 * goes through the transaction. Throwing rolls back; returning commits.
 *
 * The adapter must provide a real transaction; running inline could partially
 * commit payment source identities, transactions, or aggregate counts.
 */
export async function withTransaction<T>(
  runtime: IAgentRuntime,
  fn: (tx: TransactionalDb) => Promise<T>,
): Promise<T> {
  const db = getRuntimeDb(runtime) as DrizzleTransactionalDb;
  if (typeof db.transaction === "function") {
    return await db.transaction(async (tx) => fn(tx));
  }
  throw new ElizaError(
    "[FinancesSql] atomic transaction support is required for multi-record finance mutations",
    {
      code: "FINANCES_TRANSACTION_REQUIRED",
      context: { agentId: runtime.agentId },
      severity: "fatal",
    },
  );
}

/** Execute a statement on the handle owned by the enclosing transaction. */
export async function executeRawSqlTx(
  tx: TransactionalDb,
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  return executeSql(tx, sqlText);
}
