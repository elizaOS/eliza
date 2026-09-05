/**
 * Resolves the scheduling runtime database and delegates common SQL primitives
 * to shared. Existing domain imports and transaction policies remain stable.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { executeSql, type RuntimeDb } from "@elizaos/shared/db/raw-sql";

export {
  asObject,
  extractRows,
  parseJsonRecord,
  parseJsonValue,
  type RawSqlQuery,
  type RuntimeDb,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  toBoolean,
  toText,
} from "@elizaos/shared/db/raw-sql";

export type SchedulingSqlExecutor = (
  sqlText: string,
) => Promise<Array<Record<string, unknown>>>;

export function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb | null {
  const adapterDb = runtime.adapter?.db as RuntimeDb | undefined;
  if (adapterDb && typeof adapterDb.execute === "function") return adapterDb;
  const runtimeDb = (runtime as IAgentRuntime & { db?: RuntimeDb }).db;
  if (runtimeDb && typeof runtimeDb.execute === "function") return runtimeDb;
  return null;
}

export async function executeRawSql(
  runtime: IAgentRuntime,
  sqlText: string,
): Promise<Array<Record<string, unknown>>> {
  const db = getRuntimeDb(runtime);
  if (!db)
    throw new Error(
      "[SchedulingSql] runtime database adapter unavailable; load @elizaos/plugin-sql before durable scheduling.",
    );
  return executeSql(db, sqlText);
}

export function createRuntimeSchedulingSqlExecutor(
  runtime: IAgentRuntime,
): SchedulingSqlExecutor {
  return (sqlText) => executeRawSql(runtime, sqlText);
}
