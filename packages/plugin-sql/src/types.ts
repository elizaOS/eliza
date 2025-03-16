import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

/**
 * Represents a type that can be either a NodePgDatabase or a PgliteDatabase.
 */
export type TDatabase = NodePgDatabase<any> | PgliteDatabase<any>;

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

/**
 * Interface representing different database operations supported by Drizzle.
 */

export interface DrizzleOperations {
  select: (...args: any[]) => any;
  selectDistinct: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(cb: (tx: any) => Promise<T>) => Promise<T>;
  execute<_T = Record<string, unknown>>(query: SQL): Promise<{ rows: any[] } & Record<string, any>>;
}

/**
 * A custom type representing a database that can be either a NodePgDatabase or a PgliteDatabase.
 */
export type DrizzleDatabase = NodePgDatabase | PgliteDatabase;

/**
 * The type representing a combination of DrizzleDatabase and DrizzleOperations.
 */
export type DatabaseType = DrizzleDatabase & DrizzleOperations;
