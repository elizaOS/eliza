import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/**
 * Represents a type that can be either a NodePgDatabase or BetterSQLite3Database.
 */
export type DrizzleDatabase = NodePgDatabase | BetterSQLite3Database;

/**
 * Interface for managing a database client.
 * @template T - The type of the database connection object.
 */
export interface IDatabaseClientManager<T> {
  initialize(): Promise<void>;
  getConnection(): T;
  runMigrations(): Promise<void>;
  close(): Promise<void>;
}
