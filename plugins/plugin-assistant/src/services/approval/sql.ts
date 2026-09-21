/**
 * Resolves the runtime approval database and delegates SQL execution and value helpers
 * to the shared owner. Existing imports and domain transaction rules remain stable.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  executeSql,
  type RuntimeDb,
  type TransactionalDb,
} from "@elizaos/shared/db/raw-sql";

export {
  parseJsonRecord,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  type TransactionalDb,
  toText,
} from "@elizaos/shared/db/raw-sql";

function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb {
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
