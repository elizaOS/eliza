import { logger, type Relationship, type UUID } from '@elizaos/core';
import { and, eq, SQL, sql } from 'drizzle-orm';
import { v4 } from 'uuid';
import { relationshipTable } from '../schema/index';
import type { DrizzleDatabase } from '../types';
import type { Store, StoreContext } from './types';

export class RelationshipStore implements Store {
  constructor(public readonly ctx: StoreContext) {}

  private get db(): DrizzleDatabase {
    return this.ctx.getDb();
  }

  async create(params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: { [key: string]: unknown };
  }): Promise<boolean> {
    return this.ctx.withRetry(async () => {
      const id = v4();
      const saveParams = {
        id,
        sourceEntityId: params.sourceEntityId,
        targetEntityId: params.targetEntityId,
        agentId: this.ctx.agentId,
        tags: params.tags || [],
        metadata: params.metadata || {},
      };
      try {
        await this.db.insert(relationshipTable).values(saveParams);
        return true;
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            agentId: this.ctx.agentId,
            error: error instanceof Error ? error.message : String(error),
            saveParams,
          },
          'Error creating relationship'
        );
        return false;
      }
    }, 'RelationshipStore.create');
  }

  async update(relationship: Relationship): Promise<void> {
    return this.ctx.withRetry(async () => {
      try {
        await this.db
          .update(relationshipTable)
          .set({
            tags: relationship.tags || [],
            metadata: relationship.metadata || {},
          })
          .where(eq(relationshipTable.id, relationship.id));
      } catch (error) {
        logger.error(
          {
            src: 'plugin:sql',
            agentId: this.ctx.agentId,
            error: error instanceof Error ? error.message : String(error),
            relationshipId: relationship.id,
          },
          'Error updating relationship'
        );
        throw error;
      }
    }, 'RelationshipStore.update');
  }

  async get(params: { sourceEntityId: UUID; targetEntityId: UUID }): Promise<Relationship | null> {
    return this.ctx.withRetry(async () => {
      const { sourceEntityId, targetEntityId } = params;
      const result = await this.db
        .select()
        .from(relationshipTable)
        .where(
          and(
            eq(relationshipTable.sourceEntityId, sourceEntityId),
            eq(relationshipTable.targetEntityId, targetEntityId)
          )
        );

      if (result.length === 0) return null;

      const relationship = result[0];
      return {
        ...relationship,
        id: relationship.id as UUID,
        sourceEntityId: relationship.sourceEntityId as UUID,
        targetEntityId: relationship.targetEntityId as UUID,
        agentId: relationship.agentId as UUID,
        tags: relationship.tags ?? [],
        metadata: (relationship.metadata as Record<string, unknown>) ?? {},
        createdAt: relationship.createdAt.toISOString(),
      };
    }, 'RelationshipStore.get');
  }

  async getAll(params: { entityId: UUID; tags?: string[] }): Promise<Relationship[]> {
    return this.ctx.withRetry(async () => {
      const { entityId, tags } = params;

      let query: SQL;

      if (tags && tags.length > 0) {
        query = sql`
          SELECT * FROM ${relationshipTable}
          WHERE (${relationshipTable.sourceEntityId} = ${entityId} OR ${relationshipTable.targetEntityId} = ${entityId})
          AND ${relationshipTable.tags} && CAST(ARRAY[${sql.join(tags, sql`, `)}] AS text[])
        `;
      } else {
        query = sql`
          SELECT * FROM ${relationshipTable}
          WHERE ${relationshipTable.sourceEntityId} = ${entityId} OR ${relationshipTable.targetEntityId} = ${entityId}
        `;
      }

      const result = await this.db.execute(query);

      return result.rows.map((relationship: Record<string, unknown>) => ({
        ...relationship,
        id: relationship.id as UUID,
        sourceEntityId: (relationship.source_entity_id || relationship.sourceEntityId) as UUID,
        targetEntityId: (relationship.target_entity_id || relationship.targetEntityId) as UUID,
        agentId: (relationship.agent_id || relationship.agentId) as UUID,
        tags: Array.isArray(relationship.tags) ? (relationship.tags as string[]) : [],
        metadata: (relationship.metadata as Record<string, unknown>) ?? {},
        createdAt:
          relationship.created_at || relationship.createdAt
            ? (relationship.created_at || relationship.createdAt) instanceof Date
              ? ((relationship.created_at || relationship.createdAt) as Date).toISOString()
              : new Date(
                  (relationship.created_at as string) || (relationship.createdAt as string)
                ).toISOString()
            : new Date().toISOString(),
      }));
    }, 'RelationshipStore.getAll');
  }
}
