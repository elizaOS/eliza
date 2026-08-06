declare module "bun:sqlite" {
  export interface SQLiteQuery {
    get(binding?: unknown): unknown;
    all(binding?: unknown): unknown[];
  }

  export class Database {
    constructor(filename?: string, options?: { create?: boolean; strict?: boolean; readonly?: boolean });
    exec(sql: string): void;
    run(sql: string, binding?: unknown): unknown;
    query(sql: string): SQLiteQuery;
    transaction<T>(fn: () => T): () => T;
    close(): void;
  }
}
