/**
 * Adapts the Core raw-SQL boundary to the runtime approval store, including
 * caller-owned transaction handles for atomic domain and approval writes.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  coerceRawSqlText,
  executeRawSqlOnDb,
  executeRuntimeRawSql,
  parseRawSqlJsonRecord,
  type RuntimeRawSqlDb,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
} from "@elizaos/core/raw-sql";

const options = { subsystem: "ApprovalSql" } as const;

export type TransactionalDb = RuntimeRawSqlDb;
export { coerceRawSqlText as toText, sqlInteger, sqlJson, sqlQuote, sqlText };

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  return parseRawSqlJsonRecord(value, options);
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
