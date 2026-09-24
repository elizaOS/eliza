/** Defines the synchronous SQL operations shared by native and portable SQLite engines. */
export type SqlValue = string | number | bigint | Uint8Array | null;
export type SqlRow = Record<string, SqlValue>;
export interface SqlStatement {
  get(...values: SqlValue[]): SqlRow | undefined;
  all(...values: SqlValue[]): SqlRow[];
  run(...values: SqlValue[]): { changes: number | bigint };
}
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}


export interface SQLiteDriver {
  readonly supportsFileSystem: boolean;
  assertSupportedRuntime(): void;
  open(path: string): Promise<SqlDatabase>;
}
