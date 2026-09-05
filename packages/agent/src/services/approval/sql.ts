/**
 * Resolves the runtime approval database and delegates raw-SQL primitives
 * to shared. Existing domain exports and transaction boundaries remain stable.
 */

import type { IAgentRuntime } from "@elizaos/core";
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

/**
 * A caller-owned database transaction handle. Structurally identical to the
 * runtime DB, so a drizzle `db.transaction(tx => …)` callback argument is
 * accepted directly: plugins that must commit a domain mutation and its owner
 * approval together pass their `tx` into the approval store.
 */
export async function executeRawSqlTx(
  tx: TransactionalDb,
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  return executeSql(tx, sqlText);
}
