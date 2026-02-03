import { logger, type Component, type Entity, type UUID } from '@elizaos/core';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { componentTable, entityTable, participantTable } from '../schema/index';
import type { DrizzleDatabase } from '../types';
import type { Store, StoreContext } from './types';

export class EntityStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async getByIds(entityIds: UUID[]): Promise<Entity[] | null> {
    return this.ctx.withRetry(async () => {
      const result = await this.db
        .select({
          entity: entityTable,
          components: componentTable,
        })
        .from(entityTable)
        .leftJoin(componentTable, eq(componentTable.entityId, entityTable.id))
        .where(inArray(entityTable.id, entityIds));

      if (result.length === 0) return [];

      const entities: Record<UUID, Entity> = {};
      const entityComponents: Record<UUID, Entity['components']> = {};

      for (const e of result) {
        const key = e.entity.id;
        entities[key] = e.entity;
        if (entityComponents[key] === undefined) entityComponents[key] = [];
        if (e.components) {
          const componentsArray = Array.isArray(e.components) ? e.components : [e.components];
          entityComponents[key] = [...entityComponents[key], ...componentsArray];
        }
      }

      for (const k of Object.keys(entityComponents)) {
        entities[k].components = entityComponents[k];
      }

      return Object.values(entities);
    }, 'EntityStore.getByIds');
  }

  async getForRoom(roomId: UUID, includeComponents?: boolean): Promise<Entity[]> {
    return this.ctx.withRetry(async () => {
      const query = this.db
        .select({
          entity: entityTable,
          ...(includeComponents && { components: componentTable }),
        })
        .from(participantTable)
        .leftJoin(
          entityTable,
          and(
            eq(participantTable.entityId, entityTable.id),
            eq(entityTable.agentId, this.ctx.agentId)
          )
        );

      if (includeComponents) {
        query.leftJoin(componentTable, eq(componentTable.entityId, entityTable.id));
      }

      const result = await query.where(eq(participantTable.roomId, roomId));

      const entitiesByIdMap = new Map<UUID, Entity>();

      for (const row of result) {
        if (!row.entity) continue;

        const entityId = row.entity.id as UUID;
        if (!entitiesByIdMap.has(entityId)) {
          const entity: Entity = {
            ...row.entity,
            id: entityId,
            agentId: row.entity.agentId as UUID,
            metadata: row.entity.metadata as Record<string, unknown>,
            components: includeComponents ? [] : undefined,
          };
          entitiesByIdMap.set(entityId, entity);
        }

        if (includeComponents && row.components) {
          const entity = entitiesByIdMap.get(entityId);
          if (entity) {
            if (!entity.components) entity.components = [];
            entity.components.push(row.components as Component);
          }
        }
      }

      return Array.from(entitiesByIdMap.values());
    }, 'EntityStore.getForRoom');
  }

  async create(entities: Entity[]): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      try {
        return await this.db.transaction(async (tx) => {
          const normalizedEntities = entities.map((entity) => ({
            ...entity,
            names: this.normalizeNames(entity.names),
            metadata: entity.metadata || {},
          }));

          await tx.insert(entityTable).values(normalizedEntities).onConflictDoNothing();
          return true;
        });
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            entityId: entities[0]?.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to create entities'
        );
        return false;
      }
    }, 'EntityStore.create');
  }

  async ensureExists(entity: Entity): Promise<boolean> {
    if (!entity.id) {
      logger.error({ src: 'plugin:sql' }, 'Entity ID is required for ensureExists');
      return false;
    }

    try {
      const existingEntities = await this.getByIds([entity.id]);
      if (!existingEntities || !existingEntities.length) {
        return await this.create([entity]);
      }
      return true;
    } catch (error) {
      logger.error(
        {
          src: 'plugin:sql',
          entityId: entity.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to ensure entity exists'
      );
      return false;
    }
  }

  async update(entity: Entity): Promise<void> {
    if (!entity.id) throw new Error('Entity ID is required for update');

    return this.ctx.withRetry(async () => {
      const normalizedEntity = {
        ...entity,
        names: this.normalizeNames(entity.names),
        metadata: entity.metadata || {},
      };

      await this.db
        .update(entityTable)
        .set(normalizedEntity)
        .where(eq(entityTable.id, entity.id as string));
    }, 'EntityStore.update');
  }

  async delete(entityId: UUID): Promise<void> {
    return this.ctx.withRetry(async () => {
      await this.db.transaction(async (tx) => {
        await tx
          .delete(componentTable)
          .where(
            or(eq(componentTable.entityId, entityId), eq(componentTable.sourceEntityId, entityId))
          );
        await tx.delete(entityTable).where(eq(entityTable.id, entityId));
      });
    }, 'EntityStore.delete');
  }

  async getByNames(params: { names: string[]; agentId: UUID }): Promise<Entity[]> {
    return this.ctx.withRetry(async () => {
      const { names, agentId } = params;
      const nameConditions = names.map((name) => sql`${name} = ANY(${entityTable.names})`);

      const query = sql`
        SELECT * FROM ${entityTable}
        WHERE ${entityTable.agentId} = ${agentId}
        AND (${sql.join(nameConditions, sql` OR `)})
      `;

      const result = await this.db.execute(query);

      return result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as UUID,
        agentId: row.agentId as UUID,
        names: Array.isArray(row.names) ? (row.names as string[]) : [],
        metadata: (row.metadata as Record<string, unknown>) || {},
      }));
    }, 'EntityStore.getByNames');
  }

  async searchByName(params: { query: string; agentId: UUID; limit?: number }): Promise<Entity[]> {
    return this.ctx.withRetry(async () => {
      const { query, agentId, limit = 10 } = params;

      if (!query || query.trim() === '') {
        const result = await this.db
          .select()
          .from(entityTable)
          .where(eq(entityTable.agentId, agentId))
          .limit(limit);

        return result.map((row: Record<string, unknown>) => ({
          id: row.id as UUID,
          agentId: row.agentId as UUID,
          names: Array.isArray(row.names) ? (row.names as string[]) : [],
          metadata: (row.metadata as Record<string, unknown>) || {},
        }));
      }

      const searchQuery = sql`
        SELECT * FROM ${entityTable}
        WHERE ${entityTable.agentId} = ${agentId}
        AND EXISTS (
          SELECT 1 FROM unnest(${entityTable.names}) AS name
          WHERE LOWER(name) LIKE LOWER(${'%' + query + '%'})
        )
        LIMIT ${limit}
      `;

      const result = await this.db.execute(searchQuery);

      return result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as UUID,
        agentId: row.agentId as UUID,
        names: Array.isArray(row.names) ? (row.names as string[]) : [],
        metadata: (row.metadata as Record<string, unknown>) || {},
      }));
    }, 'EntityStore.searchByName');
  }

  private normalizeNames(names: unknown): string[] {
    if (names == null) return [];
    if (typeof names === 'string') return [names];
    if (Array.isArray(names)) return names.map(String);
    if (names instanceof Set) return Array.from(names).map(String);
    if (
      typeof names === 'object' &&
      typeof (names as Iterable<unknown>)[Symbol.iterator] === 'function'
    ) {
      return Array.from(names as Iterable<unknown>).map(String);
    }
    return [String(names)];
  }
}
