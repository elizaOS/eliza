import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

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

export interface SchemaSnapshot {
  version: string;
  dialect: string;
  tables: any;
  schemas: any;
  enums?: any;
  _meta: {
    schemas: any;
    tables: any;
    columns: any;
  };
  internal?: any;
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
