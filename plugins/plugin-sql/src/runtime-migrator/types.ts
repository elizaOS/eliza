import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

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

// Schema column definition
export interface SchemaColumn {
  name: string;
  type: string;
  primaryKey?: boolean;
  notNull?: boolean;
  default?: string | number | boolean;
  isUnique?: boolean;
  uniqueName?: string;
  uniqueType?: string;
}

// Index column definition
export interface IndexColumn {
  expression: string;
  isExpression: boolean;
  asc?: boolean;
  nulls?: string;
}

// Index definition
export interface SchemaIndex {
  name: string;
  columns: IndexColumn[];
  isUnique: boolean;
  method?: string;
  where?: string;
  concurrently?: boolean;
}

// Foreign key definition
export interface SchemaForeignKey {
  name: string;
  tableFrom: string;
  schemaFrom?: string;
  tableTo: string;
  schemaTo: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete?: string;
  onUpdate?: string;
}

// Primary key definition
export interface SchemaPrimaryKey {
  name: string;
  columns: string[];
}

// Unique constraint definition
export interface SchemaUniqueConstraint {
  name: string;
  columns: string[];
  nullsNotDistinct?: boolean;
}

// Check constraint definition
export interface SchemaCheckConstraint {
  name: string;
  value: string;
}

// Table definition
export interface SchemaTable {
  name: string;
  schema: string;
  columns: Record<string, SchemaColumn>;
  indexes: Record<string, SchemaIndex>;
  foreignKeys: Record<string, SchemaForeignKey>;
  compositePrimaryKeys: Record<string, SchemaPrimaryKey>;
  uniqueConstraints: Record<string, SchemaUniqueConstraint>;
  checkConstraints: Record<string, SchemaCheckConstraint>;
}

// Enum definition
export interface SchemaEnum {
  name: string;
  schema: string;
  values: string[];
}

// Meta information
export interface SchemaMeta {
  schemas: Record<string, string>;
  tables: Record<string, string>;
  columns: Record<string, string>;
}

export interface SchemaSnapshot {
  version: string;
  dialect: string;
  tables: Record<string, SchemaTable>;
  schemas: Record<string, string>;
  enums?: Record<string, SchemaEnum>;
  _meta: SchemaMeta;
  internal?: Record<string, unknown>;
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
