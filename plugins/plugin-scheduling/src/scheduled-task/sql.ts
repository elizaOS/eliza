/**
 * Adapts the Core raw-SQL boundary for the scheduling store while preserving
 * its optional-database probe and injected executor surface.
 */
import {
  asRawSqlRecord,
  coerceRawSqlBoolean,
  coerceRawSqlText,
  executeRuntimeRawSql,
  extractRawSqlRows,
  findRuntimeRawSqlDb,
  type IAgentRuntime,
  parseRawSqlJsonRecord,
  parseRawSqlJsonValue,
  type RawSqlQuery,
  type RuntimeRawSqlDb,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
} from "@elizaos/core";

const options = { subsystem: "SchedulingSql", allowRuntimeDb: true } as const;

export type { RawSqlQuery };
export type RuntimeDb = RuntimeRawSqlDb;
export type SchedulingSqlExecutor = (
  sqlTextValue: string,
) => Promise<Array<Record<string, unknown>>>;
export {
  asRawSqlRecord as asObject,
  coerceRawSqlBoolean as toBoolean,
  coerceRawSqlText as toText,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
};

export function parseJsonValue<T>(value: unknown, fallback: T): T {
  return parseRawSqlJsonValue(value, fallback, options);
}

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  return parseRawSqlJsonRecord(value, options);
}

export function extractRows(result: unknown): Array<Record<string, unknown>> {
  return extractRawSqlRows(result, options);
}

export function getRuntimeDb(runtime: IAgentRuntime): RuntimeDb | null {
  return findRuntimeRawSqlDb(runtime, options);
}

export function executeRawSql(
  runtime: IAgentRuntime,
  sqlTextValue: string,
): Promise<Array<Record<string, unknown>>> {
  return executeRuntimeRawSql(runtime, sqlTextValue, options);
}

export function createRuntimeSchedulingSqlExecutor(
  runtime: IAgentRuntime,
): SchedulingSqlExecutor {
  return (sqlTextValue) => executeRawSql(runtime, sqlTextValue);
}
