/**
 * Database Query Helpers
 *
 * Helper functions for common database operations using Drizzle ORM.
 */

import type { sql } from "drizzle-orm";
import type postgres from "postgres";
import type { DrizzleClient, SQLValue } from "./client";
import type { Database } from "./db";
import type { DatabaseErrorType } from "./types";

/**
 * Re-export SQLValue type for convenience.
 */
export type { SQLValue };

/**
 * Execute a raw SQL query and return typed results.
 *
 * @param db - Database instance
 * @param query - SQL query constructed using Drizzle's sql template tag
 * @returns Array of result rows with the specified type
 */
export async function $queryRaw<
  T extends Record<string, SQLValue> = Record<string, SQLValue>,
>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return Array.from(result) as T[];
}

/**
 * Execute a raw SQL statement (INSERT, UPDATE, DELETE).
 *
 * @param db - Database instance
 * @param query - SQL query constructed using Drizzle's sql template tag
 * @returns Always returns 1 to indicate success
 */
export async function $executeRaw(
  db: Database,
  query: ReturnType<typeof sql>,
): Promise<number> {
  await db.execute(query);
  return 1;
}

/**
 * Retry an async operation with exponential backoff on retryable errors.
 *
 * @param operation - Async operation to retry
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @param delayMs - Initial delay in milliseconds (default: 100)
 * @returns Result of the operation
 * @throws Error if operation fails after all retries
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  delayMs = 100,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const dbError: DatabaseErrorType =
        error instanceof Error
          ? error
          : typeof error === "object" && error !== null && "message" in error
            ? (error as DatabaseErrorType)
            : new Error(String(error));

      lastError =
        dbError instanceof Error ? dbError : new Error(String(dbError));
      if (!isRetryableError(dbError) || attempt === maxRetries) {
        throw lastError;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, delayMs * 2 ** attempt),
      );
    }
  }

  throw lastError;
}

/**
 * Determine if a database error is retryable.
 * Retryable errors include connection issues, timeouts, and deadlocks.
 *
 * @param error - Error to check
 * @returns True if the error is retryable, false otherwise
 */
export function isRetryableError(error: DatabaseErrorType): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes("connection") ||
      message.includes("timeout") ||
      message.includes("deadlock") ||
      message.includes("econnrefused") ||
      message.includes("econnreset")
    );
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const errorMessage = String(error.message || "").toLowerCase();
    return (
      errorMessage.includes("connection") ||
      errorMessage.includes("timeout") ||
      errorMessage.includes("deadlock") ||
      errorMessage.includes("econnrefused") ||
      errorMessage.includes("econnreset")
    );
  }
  return false;
}

/**
 * Connect to database.
 * No-op for Drizzle as connections are handled automatically.
 */
export async function $connect(): Promise<void> {
  // No-op - Drizzle handles connections automatically
}

/**
 * Disconnect from database and clean up connection resources.
 */
export async function $disconnect(): Promise<void> {
  type PostgresClient = ReturnType<typeof postgres>;
  const globalForDb = globalThis as typeof globalThis & {
    postgresClient: PostgresClient | undefined;
    drizzleDb: Database | undefined;
    db: DrizzleClient | undefined;
  };

  if (globalForDb.postgresClient) {
    await globalForDb.postgresClient.end();
    globalForDb.postgresClient = undefined;
  }

  globalForDb.drizzleDb = undefined;
  globalForDb.db = undefined;
}
