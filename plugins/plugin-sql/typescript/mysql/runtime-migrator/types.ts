import type { MySql2Database } from "drizzle-orm/mysql2";

// Re-export abstract schema types from core — these are now the canonical
// source for SchemaTable, SchemaColumn, SchemaIndex, etc.
export type {
  IndexColumn,
  SchemaCheckConstraint,
  SchemaColumn,
  SchemaEnum,
  SchemaForeignKey,
  SchemaIndex,
  SchemaMeta,
  SchemaPrimaryKey,
  SchemaSnapshot,
  SchemaTable,
  SchemaUniqueConstraint,
} from "@elizaos/core";

export type DrizzleDB = MySql2Database;

export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface MigrationMeta {
  sql: string[];
  folderMillis: number;
  hash: string;
  bps: boolean;
}

// Database introspection row types (adapted for MySQL INFORMATION_SCHEMA)
export interface TableInfoRow {
  TABLE_SCHEMA: string;
  TABLE_NAME: string;
}

export interface ColumnInfoRow {
  COLUMN_NAME: string;
  IS_NULLABLE: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string;
  COLUMN_DEFAULT: string | null;
  COLUMN_KEY: string;
  EXTRA: string;
}

export interface IndexInfoRow {
  INDEX_NAME: string;
  NON_UNIQUE: number;
  COLUMN_NAME: string;
  SEQ_IN_INDEX: number;
  INDEX_TYPE: string;
}

export interface ForeignKeyInfoRow {
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_SCHEMA: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  DELETE_RULE: string;
  UPDATE_RULE: string;
}

export interface PrimaryKeyInfoRow {
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
}

export interface UniqueConstraintInfoRow {
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
}

export interface CheckConstraintInfoRow {
  CONSTRAINT_NAME: string;
  CHECK_CLAUSE: string;
}

export interface EnumInfoRow {
  // MySQL doesn't have dedicated ENUM types like PostgreSQL
  // ENUM is a column type, not a standalone type
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
}

export interface MigrationOptions {
  migrationsTable?: string;
  migrationsSchema?: string;
}

export interface RuntimeMigrationOptions {
  /** Run without executing SQL statements */
  dryRun?: boolean;

  /** Log detailed information about the migration */
  verbose?: boolean;

  /** Force migration even in production with destructive changes */
  force?: boolean;

  /** Allow operations that will cause data loss (tables/columns being dropped) */
  allowDataLoss?: boolean;
}

/**
 * Extract a single row from a MySQL db.execute() result.
 * MySQL2 driver returns [rows, fields], so we access result[0][index].
 * Falls back to {rows: [...]} format for compatibility.
 */
export function getMysqlRow<T>(result: unknown, index = 0): T | undefined {
  if (Array.isArray(result) && Array.isArray(result[0])) {
    return result[0][index] as T | undefined;
  }
  // Fallback for {rows: [...]} format
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: unknown[] }).rows[index] as T | undefined;
  }
  return undefined;
}

/**
 * Extract all rows from a MySQL db.execute() result.
 * MySQL2 driver returns [rows, fields], so we access result[0].
 */
export function getMysqlRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: unknown[] }).rows as T[];
  }
  return [];
}
