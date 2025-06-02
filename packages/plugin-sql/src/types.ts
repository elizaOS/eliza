import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SQL } from 'drizzle-orm';

/**
 * Represents a type that can be either a NodePgDatabase or BetterSQLite3Database.
 */
export type DrizzleDatabase = BetterSQLite3Database | NodePgDatabase;

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

// Type guards
export function isSQLiteDatabase(db: DrizzleDatabase): db is BetterSQLite3Database {
  return (
    (db as any).session?.adapterName === 'better-sqlite3' ||
    (db as any).getDialect?.().name === 'sqlite'
  );
}

export function isPostgreSQLDatabase(db: DrizzleDatabase): db is NodePgDatabase {
  return !isSQLiteDatabase(db);
}

// Common database operations interface
export interface DatabaseOperations {
  select(fields?: any): any;
  insert(table: any): any;
  update(table: any): any;
  delete(table: any): any;
  transaction<T>(fn: (tx: any) => T | Promise<T>): T | Promise<T>;
}

// Type-safe wrapper for database operations
export class DatabaseWrapper {
  constructor(private db: DrizzleDatabase) {}

  get isSQLite(): boolean {
    return isSQLiteDatabase(this.db);
  }

  get isPostgreSQL(): boolean {
    return isPostgreSQLDatabase(this.db);
  }

  async executeTransaction<T>(fn: (tx: any) => T | Promise<T>): Promise<T> {
    if (this.isSQLite) {
      const sqliteDb = this.db as BetterSQLite3Database;
      // SQLite transactions are synchronous
      return sqliteDb.transaction(fn as any)() as T;
    } else {
      const pgDb = this.db as NodePgDatabase;
      // PostgreSQL transactions are asynchronous
      return pgDb.transaction(fn);
    }
  }

  select(fields?: any) {
    return this.db.select(fields);
  }

  insert(table: any) {
    return this.db.insert(table);
  }

  update(table: any) {
    return this.db.update(table);
  }

  delete(table: any) {
    return this.db.delete(table);
  }
}

// Export type for SQL-based operations
export type { SQL };
