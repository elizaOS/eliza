import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

/**
 * Represents a type that can be either a PostgresJsDatabase or a PgliteDatabase.
 */
export type DrizzleDatabase = PostgresJsDatabase | PgliteDatabase;

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
