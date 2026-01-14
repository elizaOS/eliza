import { type UUID, type World } from '@elizaos/core';
import { eq } from 'drizzle-orm';
import { v4 } from 'uuid';
import { worldTable } from '../schema/index';
import type { DrizzleDatabase } from '../types';
import type { Store, StoreContext } from './types';

export class WorldStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async create(world: World): Promise<UUID> {
    return this.ctx.withRetry(async () => {
      const newWorldId = world.id || v4();
      await this.db
        .insert(worldTable)
        .values({
          ...world,
          id: newWorldId,
          name: world.name || '',
        })
        .onConflictDoNothing();
      return newWorldId;
    }, 'WorldStore.create');
  }

  async get(id: UUID): Promise<World | null> {
    return this.ctx.withRetry(async () => {
      const result = await this.db.select().from(worldTable).where(eq(worldTable.id, id));
      return result.length > 0 ? (result[0] as World) : null;
    }, 'WorldStore.get');
  }

  async getAll(): Promise<World[]> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select()
        .from(worldTable)
        .where(eq(worldTable.agentId, this.ctx.agentId));
      return result as World[];
    }, 'WorldStore.getAll');
  }

  async update(world: World): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db.update(worldTable).set(world).where(eq(worldTable.id, world.id));
    }, 'WorldStore.update');
  }

  async remove(id: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db.delete(worldTable).where(eq(worldTable.id, id));
    }, 'WorldStore.remove');
  }
}
