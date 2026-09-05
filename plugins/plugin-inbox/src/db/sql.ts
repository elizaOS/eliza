/**
 * Resolves the inbox runtime database and delegates raw-SQL primitives
 * to shared. Existing domain exports and transaction boundaries remain stable.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { executeSql, type RuntimeDb } from "@elizaos/shared/db/raw-sql";

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
