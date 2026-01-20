import { type Agent, logger, type UUID } from '@elizaos/core';
import { count, eq } from 'drizzle-orm';
import { agentTable } from '../schema/index';
import type { DrizzleDatabase } from '../types';
import type { Store, StoreContext } from './types';

export class AgentStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async get(agentId: UUID): Promise<Agent | null> {
    return this.ctx.withRetry(async () => {
      const rows = await this.db
        .select()
        .from(agentTable)
        .where(eq(agentTable.id, agentId))
        .limit(1);

      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        ...row,
        username: row.username || '',
        id: row.id as UUID,
        system: !row.system ? undefined : row.system,
        bio: !row.bio ? '' : row.bio,
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
        settings: row.settings as Agent['settings'],
      };
    }, 'AgentStore.get');
  }

  async getAll(): Promise<Partial<Agent>[]> {
    const result = await this.ctx.withRetry(async () => {
      const rows = await this.db
        .select({
          id: agentTable.id,
          name: agentTable.name,
          bio: agentTable.bio,
        })
        .from(agentTable);
      return rows.map((row) => ({
        ...row,
        id: row.id as UUID,
        bio: row.bio === null ? '' : row.bio,
      }));
    }, 'AgentStore.getAll');
    return result || [];
  }

  async create(agent: Agent): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        if (agent.id) {
          const existing = await this.db
            .select({ id: agentTable.id })
            .from(agentTable)
            .where(eq(agentTable.id, agent.id))
            .limit(1);

          if (existing.length > 0) {
            logger.warn(
              { src: 'plugin:sql', agentId: agent.id },
              'Attempted to create agent with duplicate ID'
            );
            return false;
          }
        }

        await this.db.transaction(async (tx) => {
          await tx.insert(agentTable).values({
            ...agent,
            createdAt: new Date(agent.createdAt || Date.now()),
            updatedAt: new Date(agent.updatedAt || Date.now()),
          });
        });

        return true;
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            agentId: agent.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to create agent'
        );
        return false;
      }
    }, 'AgentStore.create');
  }

  async update(agentId: UUID, agent: Partial<Agent>): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        if (!agentId) {
          throw new Error('Agent ID is required for update');
        }

        await this.db.transaction(async (tx) => {
          if (agent?.settings) {
            agent.settings = await this.mergeSettings(tx, agentId, agent.settings);
          }

          const updateData: Record<string, unknown> = { ...agent };

          if (updateData.createdAt) {
            if (typeof updateData.createdAt === 'number') {
              updateData.createdAt = new Date(updateData.createdAt);
            } else {
              delete updateData.createdAt;
            }
          }
          if (updateData.updatedAt) {
            if (typeof updateData.updatedAt === 'number') {
              updateData.updatedAt = new Date(updateData.updatedAt);
            } else {
              updateData.updatedAt = new Date();
            }
          } else {
            updateData.updatedAt = new Date();
          }

          await tx.update(agentTable).set(updateData).where(eq(agentTable.id, agentId));
        });

        return true;
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to update agent'
        );
        return false;
      }
    }, 'AgentStore.update');
  }

  async delete(agentId: UUID): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        const result = await this.db
          .delete(agentTable)
          .where(eq(agentTable.id, agentId))
          .returning();

        if (result.length === 0) {
          logger.warn({ src: 'plugin:sql', agentId }, 'Agent not found for deletion');
          return false;
        }

        return true;
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to delete agent'
        );
        throw error;
      }
    }, 'AgentStore.delete');
  }

  async count(): Promise<number> {
    return this.ctx.withRetry(async () => {
      try {
        const result = await this.db.select({ count: count() }).from(agentTable);
        return result[0]?.count || 0;
      } catch (error) {
        logger.error(
          { src: 'plugin:sql', error: error instanceof Error ? error.message : String(error) },
          'Failed to count agents'
        );
        return 0;
      }
    }, 'AgentStore.count');
  }

  async deleteAll(): Promise<void> {
    return this.ctx.withRetry(async () => {
      try {
        await this.db.delete(agentTable);
      } catch (error) {
        logger.error(
          { src: 'plugin:sql', error: error instanceof Error ? error.message : String(error) },
          'Failed to clean up agent table'
        );
        throw error;
      }
    }, 'AgentStore.deleteAll');
  }

  private async mergeSettings<T extends Record<string, unknown>>(
    tx: DrizzleDatabase,
    agentId: UUID,
    updatedSettings: T
  ): Promise<T> {
    const currentAgent = await tx
      .select({ settings: agentTable.settings })
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);

    const currentSettings =
      currentAgent.length > 0 && currentAgent[0].settings ? currentAgent[0].settings : {};

    const deepMerge = (
      target: Record<string, unknown> | unknown,
      source: Record<string, unknown>
    ): Record<string, unknown> | undefined => {
      if (source === null) return undefined;
      if (Array.isArray(source) || typeof source !== 'object') return source;

      const output =
        typeof target === 'object' && target !== null && !Array.isArray(target)
          ? { ...target }
          : {};

      for (const key of Object.keys(source)) {
        const sourceValue = source[key];
        if (sourceValue === null) {
          delete output[key];
        } else if (typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
          const nested = deepMerge(output[key], sourceValue as Record<string, unknown>);
          if (nested === undefined) delete output[key];
          else output[key] = nested;
        } else {
          output[key] = sourceValue;
        }
      }

      if (Object.keys(output).length === 0) {
        if (!(typeof source === 'object' && source !== null && Object.keys(source).length === 0)) {
          return undefined;
        }
      }
      return output;
    };

    const finalSettings = deepMerge(currentSettings, updatedSettings);
    return (finalSettings ?? {}) as T;
  }
}
