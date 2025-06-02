import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid as pgUuid,
  text as pgText,
  jsonb as pgJsonb,
  timestamp as pgTimestamp,
  boolean as pgBoolean,
  integer as pgInteger,
  vector as pgVector,
  check as pgCheck,
  index as pgIndex,
  foreignKey as pgForeignKey,
  type PgTableFn,
} from 'drizzle-orm/pg-core';
import {
  sqliteTable,
  text as sqliteText,
  integer as sqliteInteger,
  index as sqliteIndex,
  foreignKey as sqliteForeignKey,
  type SQLiteTableFn,
} from 'drizzle-orm/sqlite-core';
import { v4 as uuidv4 } from 'uuid';

export type DatabaseType = 'postgres' | 'sqlite';

// Type helpers for cross-database compatibility
export type TableFn = PgTableFn | SQLiteTableFn;
export type UuidColumn = ReturnType<typeof pgUuid> | ReturnType<typeof sqliteText>;
export type TextColumn = ReturnType<typeof pgText> | ReturnType<typeof sqliteText>;
export type JsonColumn = ReturnType<typeof pgJsonb> | ReturnType<typeof sqliteText>;
export type BooleanColumn = ReturnType<typeof pgBoolean> | ReturnType<typeof sqliteInteger>;
export type TimestampColumn = ReturnType<typeof pgTimestamp> | ReturnType<typeof sqliteInteger>;
export type IntegerColumn = ReturnType<typeof pgInteger> | ReturnType<typeof sqliteInteger>;

/**
 * Schema factory to create database-specific column types
 */
export class SchemaFactory {
  constructor(public dbType: DatabaseType) {}

  get table(): TableFn {
    return this.dbType === 'postgres' ? pgTable : sqliteTable;
  }

  uuid(name: string) {
    if (this.dbType === 'postgres') {
      return pgUuid(name);
    }
    // SQLite: Use TEXT with UUID format check
    return sqliteText(name).$default(() => uuidv4());
  }

  text(name: string) {
    return this.dbType === 'postgres' ? pgText(name) : sqliteText(name);
  }

  json(name: string) {
    if (this.dbType === 'postgres') {
      return pgJsonb(name);
    }
    // SQLite: Store JSON as TEXT
    return sqliteText(name);
  }

  boolean(name: string) {
    if (this.dbType === 'postgres') {
      return pgBoolean(name);
    }
    // SQLite: Store boolean as INTEGER (0/1)
    return sqliteInteger(name, { mode: 'boolean' });
  }

  timestamp(name: string, options?: { withTimezone?: boolean; mode?: 'date' | 'string' }) {
    if (this.dbType === 'postgres') {
      return pgTimestamp(name, options);
    }
    // SQLite: Store timestamp as INTEGER (Unix timestamp in milliseconds)
    return sqliteInteger(name, { mode: 'timestamp' });
  }

  integer(name: string) {
    return this.dbType === 'postgres' ? pgInteger(name) : sqliteInteger(name);
  }

  vector(name: string, dimensions: number) {
    if (this.dbType === 'postgres') {
      return pgVector(name, { dimensions });
    }
    // SQLite: Store vectors as JSON arrays
    return sqliteText(name);
  }

  textArray(name: string) {
    if (this.dbType === 'postgres') {
      return pgText(name).array();
    }
    // SQLite: Store arrays as JSON
    return sqliteText(name);
  }

  check(name: string, sql: any) {
    if (this.dbType === 'postgres') {
      return pgCheck(name, sql);
    }
    // SQLite doesn't support CHECK constraints in the same way
    return null;
  }

  index(name?: string) {
    return this.dbType === 'postgres' ? pgIndex(name) : sqliteIndex(name || '');
  }

  foreignKey(config: any) {
    return this.dbType === 'postgres' ? pgForeignKey(config) : sqliteForeignKey(config);
  }

  // Helper for timestamp defaults - return proper SQL defaults
  defaultTimestamp() {
    if (this.dbType === 'postgres') {
      return sql`NOW()`;
    }
    // SQLite: Use current timestamp in milliseconds
    return sql`(unixepoch() * 1000)`;
  }

  // Helper for random UUID generation
  defaultRandomUuid() {
    if (this.dbType === 'postgres') {
      return sql`gen_random_uuid()`;
    }
    // SQLite: Use application-level UUID generation
    return undefined; // Will use $default(() => uuidv4())
  }
}

// Global factory instance - will be set based on database type
let globalFactory: SchemaFactory | null = null;

export function setDatabaseType(dbType: DatabaseType) {
  globalFactory = new SchemaFactory(dbType);
}

export function getSchemaFactory(): SchemaFactory {
  if (!globalFactory) {
    // Default to postgres for backward compatibility
    globalFactory = new SchemaFactory('postgres');
  }
  return globalFactory;
}
