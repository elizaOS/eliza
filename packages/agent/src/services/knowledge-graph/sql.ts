/**
 * Resolves the runtime knowledge-graph database and delegates SQL execution and value helpers
 * to the shared owner. Existing imports and domain transaction rules remain stable.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { executeSql, type RuntimeDb } from "@elizaos/shared/db/raw-sql";

export {
  parseJsonArray,
  parseJsonRecord,
  parseJsonValue,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
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
