import { createRequire } from "node:module";

export interface SqliteStatementCompat {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | null;
  run(...params: unknown[]): unknown;
}

export interface SqliteDatabaseCompat {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementCompat;
  close(): void;
}

export interface SqliteDatabaseSyncConstructor {
  new (filename: string): SqliteDatabaseCompat;
}

interface BunSqliteQueryCompat {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | null | undefined;
  run(...params: unknown[]): unknown;
}

interface BunSqliteDatabaseCompat {
  exec(sql: string): void;
  query(sql: string): BunSqliteQueryCompat;
  close(): void;
}

interface BunSqliteModule {
  Database: new (filename: string) => BunSqliteDatabaseCompat;
}

const require = createRequire(import.meta.url);
let DatabaseSyncValue: SqliteDatabaseSyncConstructor | undefined;
let hasSqliteValue = false;

function isBunRuntime(): boolean {
  return (
    typeof process !== "undefined" && typeof process.versions?.bun === "string"
  );
}

try {
  ({ DatabaseSync: DatabaseSyncValue } = require("node:sqlite") as {
    DatabaseSync: SqliteDatabaseSyncConstructor;
  });
  hasSqliteValue = typeof DatabaseSyncValue === "function";
} catch {
  DatabaseSyncValue = undefined;
}

if (!hasSqliteValue) {
  if (isBunRuntime()) {
    try {
      const { Database } = require("bun:sqlite") as BunSqliteModule;

      class BunDatabaseSyncCompat implements SqliteDatabaseCompat {
        private readonly db: BunSqliteDatabaseCompat;

        constructor(filename: string) {
          this.db = new Database(filename);
        }

        exec(sql: string): void {
          this.db.exec(sql);
        }

        prepare(sql: string): SqliteStatementCompat {
          const query = this.db.query(sql);
          return {
            all: (...params) =>
              query.all(...params) as Array<Record<string, unknown>>,
            get: (...params) =>
              (query.get(...params) as
                | Record<string, unknown>
                | null
                | undefined) ?? null,
            run: (...params) => query.run(...params),
          };
        }

        close(): void {
          this.db.close();
        }
      }

      DatabaseSyncValue = BunDatabaseSyncCompat;
      hasSqliteValue = true;
    } catch {
      hasSqliteValue = false;
    }
  } else {
    hasSqliteValue = false;
  }
}

export const hasSqlite = hasSqliteValue;
export const DatabaseSync = DatabaseSyncValue as SqliteDatabaseSyncConstructor;
export type SqliteDatabaseSync = InstanceType<SqliteDatabaseSyncConstructor>;
