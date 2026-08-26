/**
 * Adapts the Core raw-SQL boundary to calendar repositories and retains the
 * calendar-owned atomic transaction requirement.
 */
import {
  coerceRawSqlBoolean,
  coerceRawSqlNumber,
  coerceRawSqlText,
  ElizaError,
  executeRawSqlOnDb,
  executeRuntimeRawSql,
  getRuntimeRawSqlDb,
  type IAgentRuntime,
  parseRawSqlJsonArray,
  parseRawSqlJsonRecord,
  type RawSqlQuery,
  type RuntimeRawSqlDb,
  sqlBoolean,
  sqlJson,
  sqlQuote,
  sqlText,
} from "@elizaos/core";

const options = { subsystem: "CalendarSql" } as const;

export type { RawSqlQuery };
export type RuntimeDb = RuntimeRawSqlDb;
export type TransactionalDb = RuntimeDb;
type TransactionalRuntimeDb = RuntimeDb & {
  transaction?: <T>(
    callback: (tx: TransactionalDb) => Promise<T>,
  ) => Promise<T>;
};

export {
  coerceRawSqlBoolean as toBoolean,
  coerceRawSqlNumber as toNumber,
  coerceRawSqlText as toText,
  sqlBoolean,
  sqlJson,
  sqlQuote,
  sqlText,
};

export function parseJsonRecord(value: unknown): Record<string, unknown> {
  return parseRawSqlJsonRecord(value, options);
}

export function parseJsonArray<T>(value: unknown): T[] {
  return parseRawSqlJsonArray<T>(value, options);
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

export function executeRawSqlTx(
  tx: TransactionalDb,
  sqlTextValue: string,
): Promise<Array<Record<string, unknown>>> {
  return executeRawSqlOnDb(tx, sqlTextValue, options);
}

export function sqlInteger(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new ElizaError("Invalid calendar integer SQL literal.", {
      code: "CALENDAR_SQL_INTEGER_LITERAL_INVALID",
      context: { value },
    });
  }
  return String(value);
}

/** Calendar selection and provider state must commit together. */
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
