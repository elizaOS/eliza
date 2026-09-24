/** Describes the sql.js compiled SQLite interface used by the portable driver. */
declare module "sql.js/dist/sql-asm.js" {
  type Value = string | number | Uint8Array | null;
  interface Statement {
    bind(values: Value[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, Value>;
    free(): boolean;
  }
  interface Database {
    exec(sql: string): unknown;
    prepare(sql: string): Statement;
    getRowsModified(): number;
    close(): void;
  }
  export default function initSqlJs(): Promise<{ Database: new () => Database }>;
}
