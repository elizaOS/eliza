import { logger, type Metadata, type Relationship, type UUID } from "@elizaos/core";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { v4 } from "uuid";
import { relationshipTable } from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Retrieves a relationship from the database based on source and target entity IDs.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {Object} params - The parameters for retrieving a relationship.
 * @param {UUID} params.sourceEntityId - The ID of the source entity.
 * @param {UUID} params.targetEntityId - The ID of the target entity.
 * @returns {Promise<Relationship | null>} A Promise that resolves to the relationship if found, null otherwise.
 */
export async function getRelationship(
  db: DrizzleDatabase,
  params: {
    sourceEntityId: UUID;
    targetEntityId: UUID;
  }
): Promise<Relationship | null> {
  const { sourceEntityId, targetEntityId } = params;
  const result = await db
    .select()
    .from(relationshipTable)
    .where(
      and(
        eq(relationshipTable.sourceEntityId, sourceEntityId),
        eq(relationshipTable.targetEntityId, targetEntityId)
      )
    )
    .limit(1);
  if (result.length === 0) return null;
  const relationship = result[0];
  return {
    ...relationship,
    id: relationship.id as UUID,
    sourceEntityId: relationship.sourceEntityId as UUID,
    targetEntityId: relationship.targetEntityId as UUID,
    agentId: relationship.agentId as UUID,
    tags: (relationship.tags ?? []) as string[],
    metadata: (relationship.metadata ?? {}) as Metadata,
    createdAt: relationship.createdAt.toISOString(),
  };
}

/**
 * Retrieves relationships from the database for a given entity, optionally filtered by tags.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {Object} params - The parameters for retrieving relationships.
 * @param {UUID} params.entityId - The ID of the entity to retrieve relationships for.
 * @param {string[]} [params.tags] - The tags to filter relationships by.
 * @returns {Promise<Relationship[]>} A Promise that resolves to an array of relationships.
 */
export async function getRelationships(
  db: DrizzleDatabase,
  params: { entityId: UUID; tags?: string[]; limit?: number; offset?: number }
): Promise<Relationship[]> {
  const { entityId, tags, limit, offset } = params;

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

  // WHY: Apply pagination to limit result size. Previously returned ALL relationships.
  if (limit !== undefined) {
    query = sql`${query} LIMIT ${limit}`;
  }
  if (offset !== undefined && offset > 0) {
    query = sql`${query} OFFSET ${offset}`;
  }

  const result = await db.execute(query);

  return result.rows.map((relationship: Record<string, unknown>) => ({
    ...relationship,
    id: relationship.id as UUID,
    sourceEntityId: (relationship.source_entity_id || relationship.sourceEntityId) as UUID,
    targetEntityId: (relationship.target_entity_id || relationship.targetEntityId) as UUID,
    agentId: (relationship.agent_id || relationship.agentId) as UUID,
    tags: (relationship.tags ?? []) as string[],
    metadata: (relationship.metadata ?? {}) as Metadata,
    createdAt:
      relationship.created_at || relationship.createdAt
        ? (relationship.created_at || relationship.createdAt) instanceof Date
          ? ((relationship.created_at || relationship.createdAt) as Date).toISOString()
          : new Date(
              (relationship.created_at as string) || (relationship.createdAt as string)
            ).toISOString()
        : new Date().toISOString(),
  }));
}

// Batch relationship operations

/**
 * Creates multiple relationships in the database.
 */
export async function createRelationships(
  db: DrizzleDatabase,
  agentId: UUID,
  relationships: Array<{
    sourceEntityId: UUID;
    targetEntityId: UUID;
    tags?: string[];
    metadata?: Metadata;
  }>
): Promise<UUID[]> {
  if (relationships.length === 0) return [];

  try {
    const values = relationships.map((rel) => ({
      id: v4(),
      sourceEntityId: rel.sourceEntityId,
      targetEntityId: rel.targetEntityId,
      agentId,
      tags: rel.tags || [],
      metadata: rel.metadata || {},
    }));

    await db.insert(relationshipTable).values(values);
    return values.map((v) => v.id);
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        agentId,
        count: relationships.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Error creating batch relationships"
    );
    throw error;
  }
}

/**
 * Retrieves multiple relationships by their IDs.
 */
export async function getRelationshipsByIds(
  db: DrizzleDatabase,
  relationshipIds: UUID[]
): Promise<Relationship[]> {
  if (relationshipIds.length === 0) return [];

  const result = await db
    .select()
    .from(relationshipTable)
    .where(inArray(relationshipTable.id, relationshipIds));

  return result.map((relationship) => ({
    ...relationship,
    id: relationship.id as UUID,
    sourceEntityId: relationship.sourceEntityId as UUID,
    targetEntityId: relationship.targetEntityId as UUID,
    agentId: relationship.agentId as UUID,
    tags: (relationship.tags ?? []) as string[],
    metadata: (relationship.metadata ?? {}) as Metadata,
    createdAt: relationship.createdAt.toISOString(),
  }));
}

/**
 * Updates multiple relationships in a single UPDATE using SQL CASE expressions.
 *
 * WHY CASE instead of a loop: relationships always update the same two columns
 * (tags, metadata), so we can express N updates as one statement:
 *   UPDATE relationships
 *   SET tags = CASE WHEN id=$1 THEN $2 WHEN id=$3 THEN $4 ... ELSE tags END,
 *       metadata = CASE WHEN id=$5 THEN $6 ...
 *   WHERE id IN ($1, $3, ...)
 *
 * This eliminates N-1 query parse/plan/execute cycles within the transaction.
 */
export async function updateRelationships(
  db: DrizzleDatabase,
  relationships: Relationship[]
): Promise<void> {
  if (relationships.length === 0) return;

  const ids = relationships.map((r) => r.id);
  const missing = relationships.filter((_, i) => ids[i] == null);
  if (missing.length > 0) {
    throw new Error("updateRelationships: every relationship must have an id");
  }

  const tagsCases = relationships.map((r) => {
    const tags = r.tags || [];
    const tagsLiteral =
      tags.length === 0
        ? sql`'{}'::text[]`
        : sql`ARRAY[${sql.join(
            tags.map((t) => sql`${t}`),
            sql`, `
          )}]::text[]`;
    return sql`WHEN ${relationshipTable.id} = ${r.id} THEN ${tagsLiteral}`;
  });

  const metaCases = relationships.map((r) => {
    const metaJson = JSON.stringify(r.metadata || {});
    return sql`WHEN ${relationshipTable.id} = ${r.id} THEN ${metaJson}::jsonb`;
  });

  await db
    .update(relationshipTable)
    .set({
      tags: sql`CASE ${sql.join(tagsCases, sql` `)} ELSE ${relationshipTable.tags} END`,
      metadata: sql`CASE ${sql.join(metaCases, sql` `)} ELSE ${relationshipTable.metadata} END`,
    })
    .where(inArray(relationshipTable.id, ids));
}

/**
 * Deletes multiple relationships from the database.
 */
export async function deleteRelationships(
  db: DrizzleDatabase,
  relationshipIds: UUID[]
): Promise<void> {
  if (relationshipIds.length === 0) return;

  await db.delete(relationshipTable).where(inArray(relationshipTable.id, relationshipIds));
}
