/**
 * Resolves the personal-assistant runtime database and delegates common SQL primitives
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
 * Drizzle's pg adapter supports `db.transaction(fn)` natively. An adapter that
 * cannot provide that boundary is rejected: callers use this helper because a
 * partial commit would leave household state internally inconsistent.
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
    "[LifeOpsSql] atomic transaction support is required for multi-record LifeOps mutations",
    {
      code: "LIFEOPS_TRANSACTION_REQUIRED",
      context: { agentId: runtime.agentId },
      severity: "fatal",
    },
  );
}

/**
 * Run a safety-critical mutation only when the runtime adapter can guarantee
 * a real transaction. Approval claims and provider-receipt persistence must
 * use a distinct error code because a partial commit can make an external send
 * look retriable and requires an operator-facing diagnosis.
 */
export async function withRequiredTransaction<T>(
  runtime: IAgentRuntime,
  fn: (tx: TransactionalDb) => Promise<T>,
): Promise<T> {
  const db = getRuntimeDb(runtime) as DrizzleTransactionalDb;
  if (typeof db.transaction !== "function") {
    throw new ElizaError(
      "[LifeOpsSql] atomic transaction support is required for approval-gated delivery",
      {
        code: "LIFEOPS_ATOMIC_TRANSACTION_REQUIRED",
        context: { agentId: runtime.agentId },
        severity: "fatal",
      },
    );
  }
  return db.transaction(async (tx) => fn(tx));
}

/** Execute a statement on the handle owned by the enclosing transaction. */
export async function executeRawSqlTx(
  tx: TransactionalDb,
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  return executeSql(tx, sqlText);
}
