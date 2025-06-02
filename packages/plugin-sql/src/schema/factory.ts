import { sql } from 'drizzle-orm';
import {
  boolean as pgBoolean,
  check as pgCheck,
  foreignKey as pgForeignKey,
  index as pgIndex,
  integer as pgInteger,
  jsonb as pgJsonb,
  pgTable,
  text as pgText,
  timestamp as pgTimestamp,
  uuid as pgUuid,
  vector as pgVector,
  type PgTableFn,
} from 'drizzle-orm/pg-core';

export type DatabaseType = 'postgres' | 'pglite';

// Type helpers for cross-database compatibility
// Since Pglite uses PostgreSQL dialect, we use the same types for both
export type TableFn = PgTableFn;
export type UuidColumn = ReturnType<typeof pgUuid>;
export type TextColumn = ReturnType<typeof pgText>;
export type JsonColumn = ReturnType<typeof pgJsonb>;
export type BooleanColumn = ReturnType<typeof pgBoolean>;
export type TimestampColumn = ReturnType<typeof pgTimestamp>;
export type IntegerColumn = ReturnType<typeof pgInteger>;

/**
 * Schema factory to create database-specific column types
 * Since Pglite is PostgreSQL-compatible, we use the same constructs for both
 */
export class SchemaFactory {
  constructor(public dbType: DatabaseType) {}

  get table(): TableFn {
    // Both postgres and pglite use pgTable
    return pgTable;
  }

  uuid(name: string) {
    // Both postgres and pglite support native UUID
    return pgUuid(name);
  }

  text(name: string) {
    return pgText(name);
  }

  json(name: string) {
    // Both postgres and pglite support JSONB
    return pgJsonb(name);
  }

  boolean(name: string) {
    return pgBoolean(name);
  }

  timestamp(name: string, options?: { withTimezone?: boolean; mode?: 'date' | 'string' }) {
    return pgTimestamp(name, options);
  }

  integer(name: string) {
    return pgInteger(name);
  }

  vector(name: string, dimensions: number) {
    // Pglite may not support pgvector extension yet
    // For compatibility, we'll store as JSONB for pglite
    if (this.dbType === 'pglite') {
      return pgJsonb(name);
    }
    return pgVector(name, { dimensions });
  }

  textArray(name: string) {
    // Both postgres and pglite support arrays
    return pgText(name).array();
  }

  check(name: string, sql: any) {
    // Both postgres and pglite support CHECK constraints
    return pgCheck(name, sql);
  }

  index(name?: string) {
    return pgIndex(name);
  }

  foreignKey(config: any) {
    return pgForeignKey(config);
  }

  // Helper for timestamp defaults
  defaultTimestamp() {
    // Both postgres and pglite support NOW()
    return sql`NOW()`;
  }

  // Helper for random UUID generation
  defaultRandomUuid() {
    // Pglite may not have gen_random_uuid() extension
    if (this.dbType === 'pglite') {
      // Will use application-level UUID generation
      return undefined;
    }
    return sql`gen_random_uuid()`;
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
