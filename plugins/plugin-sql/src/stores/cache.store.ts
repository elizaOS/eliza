/** Per-agent key/value cache store backed by the `cache` table (upsert on `set`, scoped by `agentId`). */
import { and, eq } from "drizzle-orm";
import { cacheTable } from "../schema/index";
import type { DrizzleDatabase } from "../types";
import type { Store, StoreContext } from "./types";

export class CacheStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async get<T>(key: string): Promise<T | undefined> {
    // No catch: undefined is the typed cache miss; a query failure propagates
    // via withRetry so "DB broken" never reads as "not cached".
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select({ value: cacheTable.value })
        .from(cacheTable)
        .where(and(eq(cacheTable.agentId, this.ctx.agentId), eq(cacheTable.key, key)))
        .limit(1);

      if (result && result.length > 0 && result[0]) {
        return result[0].value as T | undefined;
      }

      return undefined;
    }, "CacheStore.get");
  }

  async set<T>(key: string, value: T): Promise<boolean> {
    // No catch: a write failure propagates via withRetry rather than reading as
    // a benign false.
    return this.ctx.withRetry(async () => {
      await this.db
        .insert(cacheTable)
        .values({
          key: key,
          agentId: this.ctx.agentId,
          value: value,
        })
        .onConflictDoUpdate({
          target: [cacheTable.key, cacheTable.agentId],
          set: { value: value },
        });

      return true;
    }, "CacheStore.set");
  }

  async delete(key: string): Promise<boolean> {
    // No catch: a delete failure propagates via withRetry rather than reading as
    // a benign false.
    return this.ctx.withRetry(async () => {
      await this.db.transaction(async (tx) => {
        await tx
          .delete(cacheTable)
          .where(and(eq(cacheTable.agentId, this.ctx.agentId), eq(cacheTable.key, key)));
      });
      return true;
    }, "CacheStore.delete");
  }
}
