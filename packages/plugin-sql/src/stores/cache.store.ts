import { logger } from '@elizaos/core';
import { and, eq } from 'drizzle-orm';
import { cacheTable } from '../schema/index';
import type { DrizzleDatabase } from '../types';
import type { Store, StoreContext } from './types';

export class CacheStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.ctx.withRetry(async () => {
      try {
        const result = await this.db
          .select({ value: cacheTable.value })
          .from(cacheTable)
          .where(and(eq(cacheTable.agentId, this.ctx.agentId), eq(cacheTable.key, key)))
          .limit(1);

        if (result && result.length > 0 && result[0]) {
          return result[0].value as T | undefined;
        }

        return undefined;
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            agentId: this.ctx.agentId,
            error: error instanceof Error ? error.message : String(error),
            key,
          },
          'Error fetching cache'
        );
        return undefined;
      }
    }, 'CacheStore.get');
  }

  async set<T>(key: string, value: T): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
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
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            agentId: this.ctx.agentId,
            error: error instanceof Error ? error.message : String(error),
            key,
          },
          'Error setting cache'
        );
        return false;
      }
    }, 'CacheStore.set');
  }

  async delete(key: string): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .delete(cacheTable)
            .where(and(eq(cacheTable.agentId, this.ctx.agentId), eq(cacheTable.key, key)));
        });
        return true;
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            agentId: this.ctx.agentId,
            error: error instanceof Error ? error.message : String(error),
            key,
          },
          'Error deleting cache'
        );
        return false;
      }
    }, 'CacheStore.delete');
  }
}
