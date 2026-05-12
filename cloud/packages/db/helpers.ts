/**
 * Database Helper Utilities for Read/Write Intent
 *
 * Provides clean APIs for repositories to use the correct database connection
 * based on the operation type (read vs write).
 *
 * Usage in Repositories:
 * ```typescript
 * import { useReadDb, useWriteDb } from "../helpers";
 *
 * class MyRepository {
 *   // Read operations → uses the read-intent connection
 *   async findById(id: string) {
 *     return useReadDb((db) =>
 *       db.query.myTable.findFirst({ where: eq(myTable.id, id) })
 *     );
 *   }
 *
 *   // Write operations → uses primary
 *   async create(data: NewRecord) {
 *     return useWriteDb((db) =>
 *       db.insert(myTable).values(data).returning()
 *     );
 *   }
 * }
 * ```
 *
 * @module db/helpers
 */

import { logger } from "@/lib/utils/logger";
import {
  type Database,
  type DbTransaction,
  db,
  dbRead,
  dbWrite,
  getDbConnectionInfo,
} from "./client";

// ============================================================================
// Core Read/Write Helpers
// ============================================================================

/**
 * Execute a read operation using the read-intent connection.
 *
 * @example
 * const user = await useReadDb((db) =>
 *   db.query.users.findFirst({ where: eq(users.id, userId) })
 * );
 */
export function useReadDb<T>(fn: (db: Database) => T): T {
  return fn(dbRead);
}

/**
 * Execute a write operation using the primary database
 *
 * @example
 * const [user] = await useWriteDb((db) =>
 *   db.insert(users).values({ name: 'John' }).returning()
 * );
 */
export function useWriteDb<T>(fn: (db: Database) => T): T {
  return fn(dbWrite);
}

// ============================================================================
// Async Helpers (for Promise-returning operations)
// ============================================================================

/**
 * Execute an async read operation using the read-intent connection.
 *
 * @example
 * const users = await readQuery(async (db) => {
 *   return db.query.users.findMany({ limit: 100 });
 * });
 */
export async function readQuery<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  return fn(dbRead);
}

/**
 * Execute an async write operation using the primary database
 *
 * @example
 * const user = await writeQuery(async (db) => {
 *   const [created] = await db.insert(users).values(data).returning();
 *   return created;
 * });
 */
export async function writeQuery<T>(fn: (db: Database) => Promise<T>): Promise<T> {
  return fn(dbWrite);
}

// ============================================================================
// Transaction Helpers
// ============================================================================

/**
 * Execute a write transaction
 * Transactions always use the primary database
 *
 * @example
 * await writeTransaction(async (tx) => {
 *   await tx.insert(users).values(userData);
 *   await tx.insert(credits).values(creditData);
 * });
 */
export async function writeTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return dbWrite.transaction(fn);
}

// ============================================================================
// Direct DB Access (for backwards compatibility)
// ============================================================================

/**
 * Get the read database instance directly
 * Prefer useReadDb() for cleaner code
 */
export function getReadDb(): Database {
  return dbRead;
}

/**
 * Get the write database instance directly
 * Prefer useWriteDb() for cleaner code
 */
export function getWriteDb(): Database {
  return dbWrite;
}

// ============================================================================
// Monitoring & Debugging
// ============================================================================

/**
 * Log current database routing info (for debugging)
 */
export function logDbRouting(): void {
  const info = getDbConnectionInfo();
  logger.info("[DB Routing]", {
    databaseUrlConfigured: info.databaseUrlConfigured,
  });
}

/**
 * Get database routing metrics
 */
export function getDbRoutingInfo() {
  return {
    ...getDbConnectionInfo(),
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// Re-exports for convenience
// ============================================================================

export type { Database };
export { db, dbRead, dbWrite, getDbConnectionInfo };
