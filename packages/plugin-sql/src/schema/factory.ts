import { sql } from 'drizzle-orm';
import {
  boolean as pgBoolean,
  check as pgCheck,
  foreignKey as pgForeignKey,
  index as pgIndex,
  integer as pgInteger,
  jsonb as pgJsonb,
  pgTable,
  primaryKey as pgPrimaryKey,
  text as pgText,
  timestamp as pgTimestamp,
  unique as pgUnique,
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

  unique(name?: string) {
    // Both postgres and pglite support UNIQUE constraints
    return pgUnique(name);
  }

  primaryKey(config: any) {
    return pgPrimaryKey(config);
  }

  // Helper for timestamp defaults
  defaultTimestamp() {
    if (this.dbType === 'pglite') {
      return sql`CURRENT_TIMESTAMP`;
    }
    return sql`NOW()`;
  }

  // Helper for random UUID generation
  defaultRandomUuid() {
    if (this.dbType === 'pglite') {
      return undefined; // Application generates UUIDs
    }
    return sql`gen_random_uuid()`;
  }

  // Helper for JSON array defaults
  defaultJsonArray() {
    if (this.dbType === 'pglite') {
      // PGLite may handle JSON differently
      return sql`'[]'`;
    }
    return sql`'[]'::jsonb`;
  }

  // Helper for JSON object defaults
  defaultJsonObject() {
    if (this.dbType === 'pglite') {
      // PGLite may handle JSON differently
      return sql`'{}'`;
    }
    return sql`'{}'::jsonb`;
  }

  // Helper for text array defaults
  defaultTextArray() {
    if (this.dbType === 'pglite') {
      // PGLite may handle array defaults differently
      return sql`'{}'`;
    }
    return sql`'{}'::text[]`;
  }
}

// Global factory instance - will be set based on database type
let globalFactory: SchemaFactory | null = null;

export function setDatabaseType(dbType: DatabaseType) {
  globalFactory = new SchemaFactory(dbType);
}

export function getSchemaFactory(): SchemaFactory {
  if (!globalFactory) {
    globalFactory = new SchemaFactory('postgres');
  }
  return globalFactory;
}

/**
 * Helper function to create a lazy-loaded table proxy
 * This ensures the table is only created when first accessed
 * and properly forwards all property access
 */
export function createLazyTableProxy<T extends object>(createTableFn: () => T): T {
  let cachedTable: T | null = null;

  return new Proxy({} as any, {
    get(_target, prop, receiver) {
      if (!cachedTable) {
        cachedTable = createTableFn();
      }
      return Reflect.get(cachedTable, prop, receiver);
    },
    has(_target, prop) {
      if (!cachedTable) {
        cachedTable = createTableFn();
      }
      return Reflect.has(cachedTable, prop);
    },
    ownKeys(_target) {
      if (!cachedTable) {
        cachedTable = createTableFn();
      }
      return Reflect.ownKeys(cachedTable);
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (!cachedTable) {
        cachedTable = createTableFn();
      }
      return Reflect.getOwnPropertyDescriptor(cachedTable, prop);
    },

    getPrototypeOf(_target) {
      if (!cachedTable) {
        cachedTable = createTableFn();
      }
      return Reflect.getPrototypeOf(cachedTable);
    },
  }) as T;
}
