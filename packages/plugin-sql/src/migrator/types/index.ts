import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

export type DrizzleDB = NodePgDatabase | PgliteDatabase;

export interface ColumnDefinition {
  name: string;
  type: string;
  primaryKey?: boolean;
  notNull?: boolean;
  defaultValue?: string;
  unique?: boolean;
}

export interface IndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
}

export interface ForeignKeyDefinition {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: string;
}

export interface TableDefinition {
  name: string;
  columns: ColumnDefinition[];
  indexes: IndexDefinition[];
  foreignKeys: ForeignKeyDefinition[];
  checkConstraints: { name: string; expression: string }[];
  dependencies: string[]; // Tables this table depends on
  compositePrimaryKey?: { name: string; columns: string[] }; // Add composite primary key support
}
