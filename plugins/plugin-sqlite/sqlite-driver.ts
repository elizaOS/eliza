/** Selects a pinned runtime's native SQLite driver behind the same synchronous SQL contract. */
import { ElizaError } from "@elizaos/core";

import type { SqlDatabase, SqlRow, SqlValue } from "./sqlite-driver-types";
export type { SqlDatabase, SqlRow, SqlValue } from "./sqlite-driver-types";

export function assertSupportedRuntime(): void {
  const supported = process.versions.bun
    ? process.versions.bun === "1.3.14"
    : process.versions.node === "24.15.0";
  if (!supported) {
    throw new ElizaError(
      "Run SQLite storage with pinned Node 24.15.0 or Bun 1.3.14",
      {
        code: "SQLITE_RUNTIME_UNSUPPORTED",
      },
    );
  }
}

export async function openSqlite(path: string): Promise<SqlDatabase> {
  assertSupportedRuntime();
  if (!process.versions.bun) {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(path);
  }
  const { Database } = await import("bun:sqlite");
  const database = new Database(path, { strict: true });
  return {
    exec: (sql) => {
      database.exec(sql);
    },
    prepare: (sql) => {
      const statement = database.query<SqlRow, SqlValue[]>(sql);
      return {
        get: (...values) => statement.get(...values) ?? undefined,
        all: (...values) => statement.all(...values),
        run: (...values) => statement.run(...values),
      };
    },
    close: () => {
      database.close(true);
    },
  };
}

export const nativeSQLiteDriver = { supportsFileSystem: true, assertSupportedRuntime, open: openSqlite };
