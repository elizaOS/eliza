/**
 * Resolves the calendar database and delegates SQL execution and value helpers
 * to the shared owner. Existing imports and domain transaction rules remain stable.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import {
  executeSql,
  type RuntimeDb,
  type TransactionalDb,
} from "@elizaos/shared/db/raw-sql";

export {
  extractRows,
  parseJsonArray,
  parseJsonRecord,
  type RawSqlQuery,
  type RuntimeDb,
  sqlBoolean,
  sqlJson,
  sqlQuote,
  sqlText,
  type TransactionalDb,
  toBoolean,
  toNumber,
  toText,
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
  return executeSql(getRuntimeDb(runtime), sqlText);
}

/** Execute within the transaction handle owned by the calling domain. */
export async function executeRawSqlTx(
  tx: TransactionalDb,
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  return executeSql(tx, sqlText);
}

type TransactionalRuntimeDb = RuntimeDb & {
  transaction?: <T>(
    callback: (tx: TransactionalDb) => Promise<T>,
  ) => Promise<T>;
};

/** Calendar selection and provider state require one atomic transaction. */
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

/** Calendar integer fields reject fractions and unsafe integers. */
export function sqlInteger(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error("invalid integer SQL literal");
  }
  return String(value);
}
