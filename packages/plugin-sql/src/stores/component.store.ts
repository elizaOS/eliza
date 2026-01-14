import { type Component, type UUID } from '@elizaos/core';
import { and, eq } from 'drizzle-orm';
import { componentTable } from '../schema/index';
import type { DrizzleDatabase } from '../types';
import type { Store, StoreContext } from './types';

export class ComponentStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async get(
    entityId: UUID,
    type: string,
    worldId?: UUID,
    sourceEntityId?: UUID
  ): Promise<Component | null> {
    return this.ctx.withRetry(async () => {
      const conditions = [eq(componentTable.entityId, entityId), eq(componentTable.type, type)];

      if (worldId) conditions.push(eq(componentTable.worldId, worldId));
      if (sourceEntityId) conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));

      const result = await this.db
        .select()
        .from(componentTable)
        .where(and(...conditions));

      if (result.length === 0) return null;

      const component = result[0];
      return {
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? '') as UUID,
        sourceEntityId: (component.sourceEntityId ?? '') as UUID,
        data: component.data as Record<string, unknown>,
        createdAt: component.createdAt.getTime(),
      };
    }, 'ComponentStore.get');
  }

  async getAll(entityId: UUID, worldId?: UUID, sourceEntityId?: UUID): Promise<Component[]> {
    return this.ctx.withRetry(async () => {
      const conditions = [eq(componentTable.entityId, entityId)];

      if (worldId) conditions.push(eq(componentTable.worldId, worldId));
      if (sourceEntityId) conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));

      const result = await this.db
        .select({
          id: componentTable.id,
          entityId: componentTable.entityId,
          type: componentTable.type,
          data: componentTable.data,
          worldId: componentTable.worldId,
          agentId: componentTable.agentId,
          roomId: componentTable.roomId,
          sourceEntityId: componentTable.sourceEntityId,
          createdAt: componentTable.createdAt,
        })
        .from(componentTable)
        .where(and(...conditions));

      if (result.length === 0) return [];

      return result.map((component) => ({
        ...component,
        id: component.id as UUID,
        entityId: component.entityId as UUID,
        agentId: component.agentId as UUID,
        roomId: component.roomId as UUID,
        worldId: (component.worldId ?? '') as UUID,
        sourceEntityId: (component.sourceEntityId ?? '') as UUID,
        data: component.data as Record<string, unknown>,
        createdAt: component.createdAt.getTime(),
      }));
    }, 'ComponentStore.getAll');
  }

  async create(component: Component): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      await this.db.insert(componentTable).values({
        ...component,
        createdAt: new Date(),
      });
      return true;
    }, 'ComponentStore.create');
  }

  async update(component: Component): Promise<void> {
    return this.ctx.withRetry(async () => {
      const { createdAt, ...updateData } = component;
      await this.db
        .update(componentTable)
        .set(updateData)
        .where(eq(componentTable.id, component.id));
    }, 'ComponentStore.update');
  }

  async delete(componentId: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db.delete(componentTable).where(eq(componentTable.id, componentId));
    }, 'ComponentStore.delete');
  }
}
