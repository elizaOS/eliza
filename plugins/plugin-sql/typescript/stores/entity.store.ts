import { type Entity, type Metadata, type UUID, logger } from "@elizaos/core";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { componentTable, entityTable, participantTable } from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Convert a JS string[] to a PostgreSQL array literal for use in raw SQL.
 * E.g. ["Alice", "Bob"] → '{"Alice","Bob"}'
 */
function toPgTextArray(arr: string[]): string {
  if (!arr || arr.length === 0) return "{}";
  return (
    "{" +
    arr
      .map((s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"')
      .join(",") +
    "}"
  );
}

/**
 * Normalizes entity names from various input types into a string array.
 * @param {unknown} names - The names to normalize.
 * @returns {string[]} An array of normalized name strings.
 */
export function normalizeEntityNames(names: unknown): string[] {
  if (names == null) {
    return [];
  }

  if (typeof names === "string") {
    return [names];
  }

  if (Array.isArray(names)) {
    return names.map(String);
  }

  if (names instanceof Set) {
    return Array.from(names).map(String);
  }

  if (typeof names === "object" && typeof (names as any)[Symbol.iterator] === "function") {
    return Array.from(names as Iterable<unknown>).map(String);
  }

  return [String(names)];
}

/**
 * Asynchronously retrieves entities and their components by entity IDs.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID[]} entityIds - The unique identifiers of the entities to retrieve.
 * @returns {Promise<Entity[] | null>} A Promise that resolves to the entities with their components if found, empty array otherwise.
 */
export async function getEntitiesByIds(
  db: DrizzleDatabase,
  entityIds: UUID[]
): Promise<Entity[] | null> {
  const result = await db
    .select({
      entity: entityTable,
      components: componentTable,
    })
    .from(entityTable)
    .leftJoin(componentTable, eq(componentTable.entityId, entityTable.id))
    .where(inArray(entityTable.id, entityIds));

  if (result.length === 0) return [];

  // Group components by entity
  const entities: Record<UUID, Entity> = {};
  const entityComponents: Record<UUID, Entity["components"]> = {};
  for (const e of result) {
    const key = e.entity.id;
    entities[key] = e.entity;
    if (entityComponents[key] === undefined) entityComponents[key] = [];
    if (e.components) {
      // Handle both single component and array of components
      const componentsArray = Array.isArray(e.components) ? e.components : [e.components];
      entityComponents[key] = [...entityComponents[key], ...componentsArray];
    }
  }
  for (const k of Object.keys(entityComponents)) {
    entities[k].components = entityComponents[k];
  }

  return Object.values(entities);
}

/**
 * Asynchronously retrieves all entities for a given room, optionally including their components.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The ID of the agent.
 * @param {UUID} roomId - The unique identifier of the room to get entities for.
 * @param {boolean} [includeComponents] - Whether to include component data for each entity.
 * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities in the room.
 */
export async function getEntitiesForRoom(
  db: DrizzleDatabase,
  agentId: UUID,
  roomId: UUID,
  includeComponents?: boolean
): Promise<Entity[]> {
  const query = db
    .select({
      entity: entityTable,
      ...(includeComponents && { components: componentTable }),
    })
    .from(participantTable)
    .leftJoin(
      entityTable,
      and(eq(participantTable.entityId, entityTable.id), eq(entityTable.agentId, agentId))
    );

  if (includeComponents) {
    query.leftJoin(componentTable, eq(componentTable.entityId, entityTable.id));
  }

  const result = await query.where(eq(participantTable.roomId, roomId));

  // Group components by entity if includeComponents is true
  const entitiesByIdMap = new Map<UUID, Entity>();

  for (const row of result) {
    if (!row.entity) continue;

    const entityId = row.entity.id as UUID;
    if (!entitiesByIdMap.has(entityId)) {
      const entity: Entity = {
        ...row.entity,
        id: entityId,
        agentId: row.entity.agentId as UUID,
        metadata: (row.entity.metadata || {}) as Metadata,
        components: includeComponents ? [] : undefined,
      };
      entitiesByIdMap.set(entityId, entity);
    }

    if (includeComponents && (row as any).components) {
      const entity = entitiesByIdMap.get(entityId);
      if (entity) {
        if (!entity.components) {
          entity.components = [];
        }
        entity.components.push((row as any).components);
      }
    }
  }

  return Array.from(entitiesByIdMap.values());
}

/**
 * Asynchronously creates new entities in the database.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {Entity[]} entities - The entity objects to be created.
 * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating the success of the operation.
 */
export async function createEntities(
  db: DrizzleDatabase,
  entities: Entity[]
): Promise<UUID[]> {
  try {
    return await db.transaction(async (tx) => {
      // Normalize entity data to ensure names is a proper array
      const normalizedEntities = entities.map((entity) => ({
        ...entity,
        names: normalizeEntityNames(entity.names),
        metadata: entity.metadata || {},
      }));

      await tx.insert(entityTable).values(normalizedEntities);

      return entities.map(e => e.id);
    });
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        entityId: entities[0]?.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to create entities"
    );
    throw error;
  }
}

/**
 * Upsert entities (insert or update by ID)
 * 
 * WHY: Entities may be created concurrently from multiple sources (client
 * plugins, RPC handlers, background jobs). Atomic upsert prevents duplicates
 * and race conditions.
 * 
 * WHY ON CONFLICT DO UPDATE: Entities can change over time (name updates,
 * metadata changes). DO UPDATE ensures we keep the latest version.
 * 
 * WHY normalize names: The names field must be a proper array for indexing
 * and searching. Array normalization happens here (not in caller) to ensure
 * consistency across all code paths.
 * 
 * @param {DrizzleDatabase} db - The database instance
 * @param {Entity[]} entities - Array of entities to upsert (id, agentId required)
 */
export async function upsertEntities(
  db: DrizzleDatabase,
  entities: Entity[]
): Promise<void> {
  if (entities.length === 0) return;

  const normalizedEntities = entities.map((entity) => ({
    ...entity,
    names: normalizeEntityNames(entity.names),
    metadata: entity.metadata || {},
  }));

  await db
    .insert(entityTable)
    .values(normalizedEntities)
    .onConflictDoUpdate({
      target: entityTable.id,
      set: {
        // TRAP: Entity table only has: id, agent_id, created_at, names, metadata.
        // There is NO world_id column on entities (worlds are a separate table).
        agentId: sql`EXCLUDED.agent_id`,
        names: sql`EXCLUDED.names`,
        metadata: sql`EXCLUDED.metadata`,
      },
    });
}

/**
 * Asynchronously ensures an entity exists, creating it if it doesn't.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {Entity} entity - The entity to ensure exists.
 * @returns {Promise<boolean>} A Promise that resolves to a boolean indicating success.
 */
/**
 * WHY SELECT 1 instead of getEntitiesByIds: the old code called getEntitiesByIds
 * which does a SELECT * with LEFT JOIN on components -- fetching the full entity
 * plus all components just to check existence. This is called on every incoming
 * message. SELECT 1 LIMIT 1 touches only the primary key index.
 */
export async function ensureEntityExists(
  db: DrizzleDatabase,
  entity: Entity
): Promise<boolean> {
  if (!entity.id) {
    logger.error({ src: "plugin:sql" }, "Entity ID is required for ensureEntityExists");
    return false;
  }

  try {
    const existing = await db
      .select({ _: sql`1` })
      .from(entityTable)
      .where(eq(entityTable.id, entity.id))
      .limit(1);

    if (existing.length === 0) {
      await createEntities(db, [entity]);
      return true;
    }

    return true;
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        entityId: entity.id,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to ensure entity exists"
    );
    return false;
  }
}

/**
 * Asynchronously updates an entity in the database.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {Entity} entity - The entity object to be updated.
 * @returns {Promise<void>} A Promise that resolves when the entity is updated.
 */
export async function updateEntity(
  db: DrizzleDatabase,
  entity: Entity
): Promise<void> {
  if (!entity.id) {
    throw new Error("Entity ID is required for update");
  }

  // Normalize entity data to ensure names is a proper array
  const normalizedEntity = {
    ...entity,
    names: normalizeEntityNames(entity.names),
    metadata: entity.metadata || {},
  };

  await db
    .update(entityTable)
    .set(normalizedEntity)
    .where(eq(entityTable.id, entity.id as string));
}

/**
 * Asynchronously deletes an entity from the database based on the provided ID.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} entityId - The ID of the entity to delete.
 * @returns {Promise<void>} A Promise that resolves when the entity is deleted.
 */
export async function deleteEntity(
  db: DrizzleDatabase,
  entityId: UUID
): Promise<void> {
  await db.transaction(async (tx) => {
    // Delete related components first
    await tx
      .delete(componentTable)
      .where(
        or(eq(componentTable.entityId, entityId), eq(componentTable.sourceEntityId, entityId))
      );

    // Delete the entity
    await tx.delete(entityTable).where(eq(entityTable.id, entityId));
  });
}

/**
 * Asynchronously retrieves entities by their names and agentId.
 * Uses PG-specific ANY() array matching.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {Object} params - The parameters for retrieving entities.
 * @param {string[]} params.names - The names to search for.
 * @param {UUID} params.agentId - The agent ID to filter by.
 * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities.
 */
export async function getEntitiesByNames(
  db: DrizzleDatabase,
  params: { names: string[]; agentId: UUID }
): Promise<Entity[]> {
  const { names, agentId } = params;

  // Build a condition to match any of the names
  const nameConditions = names.map((name) => sql`${name} = ANY(${entityTable.names})`);

  const query = sql`
    SELECT * FROM ${entityTable}
    WHERE ${entityTable.agentId} = ${agentId}
    AND (${sql.join(nameConditions, sql` OR `)})
  `;

  const result = await db.execute(query);

  return result.rows.map((row: Record<string, unknown>) => ({
    id: row.id as UUID,
    // TRAP: Raw SQL returns snake_case column names, not camelCase
    agentId: (row.agent_id || row.agentId) as UUID,
    names: (row.names || []) as string[],
    metadata: (row.metadata || {}) as Metadata,
  }));
}

/**
 * Asynchronously searches for entities by name with fuzzy matching.
 * Uses PG-specific unnest() for array element matching.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {Object} params - The parameters for searching entities.
 * @param {string} params.query - The search query.
 * @param {UUID} params.agentId - The agent ID to filter by.
 * @param {number} [params.limit] - The maximum number of results to return.
 * @returns {Promise<Entity[]>} A Promise that resolves to an array of entities.
 */
export async function searchEntitiesByName(
  db: DrizzleDatabase,
  params: {
    query: string;
    agentId: UUID;
    limit?: number;
  }
): Promise<Entity[]> {
  const { query, agentId, limit = 10 } = params;

  // WHY: Only fetch the 4 columns we actually map into Entity objects.
  // Both code paths below only use id, agentId, names, metadata — fetching
  // additional columns (e.g. createdAt) wastes wire bytes.

  // If query is empty, return all entities up to limit
  if (!query || query.trim() === "") {
    const result = await db
      .select({
        id: entityTable.id,
        agentId: entityTable.agentId,
        names: entityTable.names,
        metadata: entityTable.metadata,
      })
      .from(entityTable)
      .where(eq(entityTable.agentId, agentId))
      .limit(limit);

    return result.map((row) => ({
      id: row.id as UUID,
      agentId: row.agentId as UUID,
      names: (row.names || []) as string[],
      metadata: (row.metadata || {}) as Metadata,
    }));
  }

  // Otherwise, search for entities with names containing the query (case-insensitive)
  const searchQuery = sql`
    SELECT id, agent_id, names, metadata FROM ${entityTable}
    WHERE ${entityTable.agentId} = ${agentId}
    AND EXISTS (
      SELECT 1 FROM unnest(${entityTable.names}) AS name
      WHERE LOWER(name) LIKE LOWER(${`%${query}%`})
    )
    LIMIT ${limit}
  `;

  const result = await db.execute(searchQuery);

  return result.rows.map((row: Record<string, unknown>) => ({
    id: row.id as UUID,
    agentId: (row.agent_id || row.agentId) as UUID,
    names: (row.names || []) as string[],
    metadata: (row.metadata || {}) as Metadata,
  }));
}

/**
 * Query entities by component properties (type and/or JSONB data filter).
 * 
 * WHY: Collapses multi-hop fetch patterns (get IDs → getEntitiesByIds → filter components)
 * into a single database-optimized query. Uses GIN index on components.data for fast
 * JSONB containment queries.
 * 
 * TWO-QUERY APPROACH (correctness): 
 * 1. Get distinct entity IDs matching component filter (with LIMIT/OFFSET)
 * 2. Fetch full entity+component data for those IDs
 * 
 * WHY two queries: Single SELECT DISTINCT ... JOIN ... LIMIT can return fewer than
 * LIMIT entities if some entities have multiple components (DISTINCT dedupes AFTER LIMIT).
 */
export async function queryEntities(
  db: DrizzleDatabase,
  params: {
    componentType?: string;
    componentDataFilter?: Record<string, unknown>;
    agentId?: UUID;
    entityIds?: UUID[];
    worldId?: UUID;
    limit?: number;
    offset?: number;
    includeAllComponents?: boolean;
  }
): Promise<Entity[]> {
  const { componentType, componentDataFilter, agentId, entityIds, worldId, limit, offset, includeAllComponents = false } = params;

  // TRAP: Prevent full table scans - require at least one meaningful filter OR explicit limit
  const hasFilter = componentType || componentDataFilter || entityIds || agentId || worldId;
  if (!hasFilter && !limit) {
    throw new Error('queryEntities requires at least one filter (componentType, componentDataFilter, entityIds, agentId, worldId) or an explicit limit');
  }

  // ── Query 1: Get matching entity IDs (with LIMIT/OFFSET applied here) ──
  const conditions: SQL[] = [];
  
  if (componentType) {
    conditions.push(eq(componentTable.type, componentType));
  }
  
  if (componentDataFilter) {
    // JSONB containment using @> operator (GIN indexed)
    conditions.push(sql`${componentTable.data}::jsonb @> ${JSON.stringify(componentDataFilter)}::jsonb`);
  }
  
  if (agentId) {
    conditions.push(eq(componentTable.agentId, agentId));
  }
  
  if (worldId) {
    conditions.push(eq(componentTable.worldId, worldId));
  }
  
  if (entityIds && entityIds.length > 0) {
    // TRAP: Chunk large entityIds arrays to avoid WASM statement size limits
    const CHUNK = 1000;
    if (entityIds.length > CHUNK) {
      const allMatchingIds: UUID[] = [];
      for (let i = 0; i < entityIds.length; i += CHUNK) {
        const chunk = entityIds.slice(i, i + CHUNK);
        const chunkResult = await db
          .select({ entityId: componentTable.entityId })
          .from(componentTable)
          .where(and(...conditions, inArray(componentTable.entityId, chunk)))
          .groupBy(componentTable.entityId);
        allMatchingIds.push(...chunkResult.map(r => r.entityId as UUID));
      }
      
      if (allMatchingIds.length === 0) return [];
      
      // Apply LIMIT/OFFSET to the chunked results
      const paginatedIds = allMatchingIds.slice(offset ?? 0, (offset ?? 0) + (limit ?? allMatchingIds.length));
      
      // ── Query 2: Fetch full entity+component data ──
      return getEntitiesByIdsWithComponentFilter(db, paginatedIds, componentType, includeAllComponents);
    } else {
      conditions.push(inArray(componentTable.entityId, entityIds));
    }
  }

  let query1 = db
    .select({ entityId: componentTable.entityId })
    .from(componentTable)
    .where(and(...conditions))
    .groupBy(componentTable.entityId);

  if (limit) {
    query1 = query1.limit(limit) as typeof query1;
  }
  
  if (offset) {
    query1 = query1.offset(offset) as typeof query1;
  }

  const matchingEntityIds = await query1;
  
  if (matchingEntityIds.length === 0) return [];

  const entityIdsToFetch = matchingEntityIds.map(r => r.entityId as UUID);

  // ── Query 2: Fetch full entity+component data for matched entity IDs ──
  return getEntitiesByIdsWithComponentFilter(db, entityIdsToFetch, componentType, includeAllComponents);
}

/**
 * Helper: Fetch entities by IDs with optional component type filtering.
 * Reuses the groupComponentsOntoEntities pattern from getEntitiesByIds.
 */
async function getEntitiesByIdsWithComponentFilter(
  db: DrizzleDatabase,
  entityIds: UUID[],
  componentType?: string,
  includeAllComponents?: boolean
): Promise<Entity[]> {
  if (entityIds.length === 0) return [];

  // Build JOIN query with optional component type filter
  const componentJoinConditions = [eq(componentTable.entityId, entityTable.id)];
  
  if (!includeAllComponents && componentType) {
    // TRAP: When includeAllComponents=false, only return the matched component type
    componentJoinConditions.push(eq(componentTable.type, componentType));
  }

  const result = await db
    .select({
      entity: entityTable,
      components: componentTable,
    })
    .from(entityTable)
    .leftJoin(componentTable, and(...componentJoinConditions))
    .where(inArray(entityTable.id, entityIds));

  if (result.length === 0) return [];

  // Group components by entity (reuse existing pattern)
  const entities: Record<UUID, Entity> = {};
  const entityComponents: Record<UUID, Entity["components"]> = {};
  
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
}

// Batch entity operations

/**
 * Updates multiple entities in the database using a single CASE-based UPDATE.
 *
 * WHY single statement: eliminates N round-trips. Each entity's names are
 * normalized in JS, then a single UPDATE … SET names = CASE …, metadata = CASE …
 * WHERE id IN (…) touches all rows at once.
 */
export async function updateEntities(
  db: DrizzleDatabase,
  entities: Entity[]
): Promise<void> {
  if (entities.length === 0) return;

  const valid = entities.filter((e) => {
    if (!e.id) {
      logger.error({ src: "plugin:sql" }, "Entity ID is required for update");
      return false;
    }
    return true;
  });
  if (valid.length === 0) return;

  const ids = valid.map((e) => e.id as string);

  const namesCases = valid.map((e) => {
    const pgArr = toPgTextArray(normalizeEntityNames(e.names));
    return sql`WHEN ${entityTable.id} = ${e.id} THEN ${pgArr}::text[]`;
  });

  const metaCases = valid.map((e) => {
    const meta = JSON.stringify(e.metadata || {});
    return sql`WHEN ${entityTable.id} = ${e.id} THEN ${meta}::jsonb`;
  });

  await db
    .update(entityTable)
    .set({
      names: sql`CASE ${sql.join(namesCases, sql` `)} ELSE ${entityTable.names} END`,
      metadata: sql`CASE ${sql.join(metaCases, sql` `)} ELSE ${entityTable.metadata} END`,
    })
    .where(inArray(entityTable.id, ids));
}

/**
 * Deletes multiple entities from the database.
 */
export async function deleteEntities(
  db: DrizzleDatabase,
  entityIds: UUID[]
): Promise<void> {
  if (entityIds.length === 0) return;

  await db.transaction(async (tx) => {
    // Delete related components first
    await tx
      .delete(componentTable)
      .where(
        or(
          inArray(componentTable.entityId, entityIds),
          inArray(componentTable.sourceEntityId, entityIds)
        )
      );

    // Delete the entities
    await tx.delete(entityTable).where(inArray(entityTable.id, entityIds));
  });
}
