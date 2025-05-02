import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import type { MySql2Database } from 'drizzle-orm/mysql2';
import type { ResultSetHeader, FieldPacket } from 'mysql2';

export type MySqlRawQueryResult = [ResultSetHeader, FieldPacket[]];

/**
 * Represents a type that can be either a NodePgDatabase, PgliteDatabase, or MySql2Database.
 */
export type TDatabase = NodePgDatabase<any> | PgliteDatabase<any> | MySql2Database<any>;

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
  execute<_T = Record<string, unknown>>(
    query: SQL
  ): Promise<({ rows: any[] } & Record<string, any>) | MySqlRawQueryResult>;
}

/**
 * A custom type representing a database that can be either a NodePgDatabase, PgliteDatabase, or MySql2Database.
 */
export type DrizzleDatabase = NodePgDatabase | PgliteDatabase | MySql2Database;

/**
 * The type representing a combination of DrizzleDatabase and DrizzleOperations.
 */
export type DatabaseType = DrizzleDatabase & DrizzleOperations;
