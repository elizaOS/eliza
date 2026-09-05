/**
 * Resolves the calendar runtime database and delegates raw-SQL primitives
 * to shared. Existing domain exports and transaction boundaries remain stable.
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

type TransactionalRuntimeDb = RuntimeDb & {
  transaction?: <T>(
    callback: (tx: TransactionalDb) => Promise<T>,
  ) => Promise<T>;
};

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

export async function executeRawSqlTx(
  tx: TransactionalDb,
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  return executeSql(tx, sqlText);
}

/**
 * Calendar selection and provider state must commit together. Reject adapters
 * without a real SQL transaction rather than presenting a partial write as a
 * recoverable preference failure.
 */
export async function withCalendarTransaction<T>(
  runtime: IAgentRuntime,
  operation: (tx: TransactionalDb) => Promise<T>,
): Promise<T> {
  const db = getRuntimeDb(runtime) as TransactionalRuntimeDb;
  if (typeof db.transaction !== "function") {
    throw new ElizaError(
      "Calendar source mutation requires an atomic database transaction.",
      {
        code: "CALENDAR_SOURCE_TRANSACTION_REQUIRED",
        context: { agentId: runtime.agentId },
        severity: "fatal",
      },
    );
  }
  return db.transaction(operation);
}
