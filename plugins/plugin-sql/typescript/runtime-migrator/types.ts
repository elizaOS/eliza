import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

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

export type DrizzleDB = NodePgDatabase | PgliteDatabase;

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

// Database introspection row types
export interface TableInfoRow {
  table_schema: string;
  table_name: string;
}

export interface ColumnInfoRow {
  column_name: string;
  is_nullable: string;
  data_type: string;
  column_default: string | null;
  is_primary: boolean;
}

export interface IndexInfoRow {
  name: string;
  is_unique: boolean;
  is_primary: boolean;
  is_unique_constraint?: boolean;
  columns: string[];
  method?: string;
}

export interface ForeignKeyInfoRow {
  name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_table_schema: string;
  foreign_column_name: string;
  delete_rule: string;
  update_rule: string;
}

export interface PrimaryKeyInfoRow {
  name: string;
  columns: string[];
}

export interface UniqueConstraintInfoRow {
  name: string;
  columns: string[];
}

export interface CheckConstraintInfoRow {
  name: string;
  definition: string;
}

export interface EnumInfoRow {
  schema: string;
  name: string;
  value: string;
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
