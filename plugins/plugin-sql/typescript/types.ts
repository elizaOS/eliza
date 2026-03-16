import type { IDatabaseAdapter } from "@elizaos/core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

export type DrizzleDatabase = NodePgDatabase | PgliteDatabase;

export interface IDatabaseClientManager<T> {
  initialize(): Promise<void>;
  getConnection(): T;
  close(): Promise<void>;
}

export function getDb(adapter: IDatabaseAdapter): DrizzleDatabase {
  return adapter.db as DrizzleDatabase;
}

export function getRow<T>(result: { rows: unknown[] }, index = 0): T | undefined {
  return result.rows[index] as T | undefined;
}
