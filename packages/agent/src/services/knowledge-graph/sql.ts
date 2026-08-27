/**
 * Adapts the Core raw-SQL boundary to the runtime knowledge-graph stores while
 * retaining their established repository helper names.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  coerceRawSqlBoolean,
  coerceRawSqlNumber,
  coerceRawSqlText,
  executeRuntimeRawSql,
  parseRawSqlJsonArray,
  parseRawSqlJsonRecord,
  parseRawSqlJsonValue,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
} from "@elizaos/core/raw-sql";

const options = { subsystem: "KnowledgeGraphSql" } as const;

export {
  coerceRawSqlBoolean as toBoolean,
  coerceRawSqlNumber as toNumber,
  coerceRawSqlText as toText,
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

export function executeRawSql(
  runtime: IAgentRuntime,
  sqlTextValue: string,
): Promise<Array<Record<string, unknown>>> {
  return executeRuntimeRawSql(runtime, sqlTextValue, options);
}
