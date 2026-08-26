/**
 * Adapts the Core raw-SQL boundary to goals-attributed parsing errors while
 * retaining the repository's established helper names.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  asRawSqlRecord,
  coerceRawSqlBoolean,
  coerceRawSqlNumber,
  coerceRawSqlText,
  executeRuntimeRawSql,
  extractRawSqlRows,
  getRuntimeRawSqlDb,
  parseRawSqlJsonArray,
  parseRawSqlJsonRecord,
  parseRawSqlJsonValue,
  type RawSqlQuery,
  type RuntimeRawSqlDb,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
} from "@elizaos/core/raw-sql";

const options = { subsystem: "GoalsSql" } as const;

export type { RawSqlQuery };
export type RuntimeDb = RuntimeRawSqlDb;
export {
  asRawSqlRecord as asObject,
  coerceRawSqlBoolean as toBoolean,
  coerceRawSqlNumber as toNumber,
  coerceRawSqlText as toText,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
};

export function parseJsonValue<T>(value: unknown, fallback: T): T {
  return parseRawSqlJsonValue(value, fallback, options);
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  return parseRawSqlJsonRecord(value, options);
}

export function parseJsonArray<T>(value: unknown): T[] {
  return parseRawSqlJsonArray<T>(value, options);
}

export function extractRows(result: unknown): Array<Record<string, unknown>> {
  return extractRawSqlRows(result, options);
}

export function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb {
  return getRuntimeRawSqlDb(runtime, options);
}

export function executeRawSql(
  runtime: IAgentRuntime,
  sqlTextValue: string,
): Promise<Array<Record<string, unknown>>> {
  return executeRuntimeRawSql(runtime, sqlTextValue, options);
}
