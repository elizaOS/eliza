import type { IDatabaseAdapter } from '@elizaos/core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

/**
 * Represents a type that can be either a NodePgDatabase or a PgliteDatabase.
 */
export type DrizzleDatabase = NodePgDatabase | PgliteDatabase;

/**
 * Interface for managing a database client.
 * @template T - The type of the database connection object.
 */
export interface IDatabaseClientManager<T> {
  initialize(): Promise<void>;
  getConnection(): T;
  close(): Promise<void>;
}

/**
 * Extract typed Drizzle database from adapter.
 * Use this instead of casting `adapter.db` everywhere.
 */
export function getDb(adapter: IDatabaseAdapter): DrizzleDatabase {
  return adapter.db as DrizzleDatabase;
}

/**
 * Type-safe row extraction from query results.
 * Avoids verbose `as unknown as T` casts.
 */
export function getRow<T>(result: { rows: unknown[] }, index = 0): T | undefined {
  return result.rows[index] as T | undefined;
}
