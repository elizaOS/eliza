import type { IDatabaseAdapter } from "@elizaos/core";
import type { MySql2Database } from "drizzle-orm/mysql2";

export type DrizzleDatabase = MySql2Database;

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
