/**
 * Repository for elizaOS entities table.
 *
 * Handles all database operations for entities without spinning up runtime.
 */

import type { Entity, UUID } from "@elizaos/core";
import { eq, inArray, sql } from "drizzle-orm";
import { sqlRows } from "@/db/execute-helpers";
import { dbRead, dbWrite } from "@/db/helpers";
import { entityTable } from "@/db/schemas/eliza";

/**
 * Input for creating a new entity.
 */
export interface CreateEntityInput {
  id: string;
  agentId: string;
  names: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Repository for elizaOS entity database operations.
 */
export class EntitiesRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Gets an entity by ID.
   *
   * @param entityId - User's database ID (UUID).
   */
  async findById(entityId: string): Promise<Entity | null> {
    const result = await dbRead
      .select()
      .from(entityTable)
      .where(eq(entityTable.id, entityId))
      .limit(1);

    return (result[0] || null) as Entity | null;
  }

  /**
   * Gets multiple entities by IDs.
   */
  async findByIds(entityIds: string[]): Promise<Entity[]> {
    if (entityIds.length === 0) return [];

    const results = await dbRead
      .select()
      .from(entityTable)
      .where(inArray(entityTable.id, entityIds));

    return results as Entity[];
  }

  /**
   * Gets entities by agent ID.
   */
  async findByAgentId(agentId: string, limit = 100): Promise<Entity[]> {
    const results = await dbRead
      .select()
      .from(entityTable)
      .where(eq(entityTable.agentId, agentId))
      .limit(limit);

    return results as Entity[];
  }

  /**
   * Checks if an entity exists.
   */
  async exists(entityId: string): Promise<boolean> {
    const result = await dbRead
      .select({ id: entityTable.id })
      .from(entityTable)
      .where(eq(entityTable.id, entityId))
      .limit(1);

    return result.length > 0;
  }

  /**
   * Counts entities for an agent.
   */
  async countByAgentId(agentId: string): Promise<number> {
    const result = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(entityTable)
      .where(eq(entityTable.agentId, agentId));

    return Number(result[0]?.count || 0);
  }

  /**
   * Finds an entity by name within an agent's entities.
   */
  async findByName(agentId: string, name: string): Promise<Entity | null> {
    type EntityRow = {
      id: string;
      agent_id: string;
      names: string[];
      metadata: Record<string, unknown> | null;
      created_at: Date;
    };
    const rows = await sqlRows<EntityRow>(
      dbRead,
      sql`
      SELECT *
      FROM ${entityTable}
      WHERE agent_id = ${agentId}::uuid
        AND ${name} = ANY(names)
      LIMIT 1
    `,
    );

    if (!rows[0]) return null;

    const row = rows[0];
    return {
      id: row.id as UUID,
      agentId: row.agent_id as UUID,
      names: row.names,
      metadata: row.metadata || undefined,
      createdAt: row.created_at.getTime(),
    } as Entity;
  }

  /**
   * Searches entities by name pattern (case-insensitive).
   */
  async searchByName(agentId: string, namePattern: string, limit = 10): Promise<Entity[]> {
    type EntityRow = {
      id: string;
      agent_id: string;
      names: string[];
      metadata: Record<string, unknown> | null;
      created_at: Date;
    };
    const rows = await sqlRows<EntityRow>(
      dbRead,
      sql`
      SELECT *
      FROM ${entityTable}
      WHERE agent_id = ${agentId}::uuid
        AND EXISTS (
          SELECT 1 FROM unnest(names) AS name
          WHERE name ILIKE ${`%${namePattern}%`}
        )
      LIMIT ${limit}
    `,
    );

    return rows.map(
      (row) =>
        ({
          id: row.id as UUID,
          agentId: row.agent_id as UUID,
          names: row.names,
          metadata: row.metadata || undefined,
          createdAt: row.created_at.getTime(),
        }) as Entity,
    );
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new entity.
   *
   * Both entityId and agentId should be UUIDs from our database.
   * Returns existing entity if already present.
   */
  async create(input: CreateEntityInput): Promise<Entity> {
    // Check if already exists
    const existing = await this.findById(input.id);
    if (existing) {
      return existing;
    }

    const result = await dbWrite
      .insert(entityTable)
      .values({
        id: input.id,
        agentId: input.agentId,
        names: input.names,
        metadata: input.metadata,
        createdAt: new Date(),
      } as typeof entityTable.$inferInsert)
      .returning();
    const [entity] = result as (typeof entityTable.$inferSelect)[];

    return entity as Entity;
  }

  /**
   * Updates entity names.
   */
  async updateNames(entityId: string, names: string[]): Promise<Entity> {
    const [entity] = await dbWrite
      .update(entityTable)
      .set({ names })
      .where(eq(entityTable.id, entityId))
      .returning();

    return entity as Entity;
  }

  /**
   * Updates entity metadata.
   */
  async updateMetadata(entityId: string, metadata: Record<string, unknown>): Promise<Entity> {
    const [entity] = await dbWrite
      .update(entityTable)
      .set({ metadata: metadata as typeof entityTable.$inferInsert.metadata })
      .where(eq(entityTable.id, entityId))
      .returning();

    return entity as Entity;
  }

  /**
   * Deletes an entity.
   *
   * @returns True if entity was deleted, false if not found.
   */
  async delete(entityId: string): Promise<boolean> {
    const result = await dbWrite
      .delete(entityTable)
      .where(eq(entityTable.id, entityId))
      .returning({ id: entityTable.id });

    return result.length > 0;
  }
}

/**
 * Singleton instance of EntitiesRepository.
 */
export const entitiesRepository = new EntitiesRepository();
