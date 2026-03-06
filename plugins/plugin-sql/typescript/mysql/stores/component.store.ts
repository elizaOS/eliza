import { type Component, type Metadata, type PatchOp, type UUID, logger } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { componentTable } from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Path validation regex: alphanumeric, underscore, and numeric array indices only.
 */
const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate and parse a dot-separated path for JSON operations.
 */
function validatePath(path: string): string[] {
  const segments = path.split('.');
  for (const seg of segments) {
    if (!PATH_SEGMENT_RE.test(seg) && !/^\d+$/.test(seg)) {
      throw new Error(
        `Invalid patch path segment: "${seg}". Only alphanumeric, underscore, and numeric indices allowed.`
      );
    }
  }
  return segments;
}

/**
 * Convert dot-separated path to MySQL JSON path.
 * E.g., "wallet.balance" → "$.wallet.balance"
 */
function toMySqlPath(segments: string[]): string {
  return '$.' + segments.join('.');
}

/**
 * Retrieves a single component for a given entity, filtered by type and optionally by world and source entity.
 */
export async function getComponent(
  db: DrizzleDatabase,
  entityId: UUID,
  type: string,
  worldId?: UUID,
  sourceEntityId?: UUID
): Promise<Component | null> {
  const conditions = [eq(componentTable.entityId, entityId), eq(componentTable.type, type)];

  if (worldId) {
    conditions.push(eq(componentTable.worldId, worldId));
  }

  if (sourceEntityId) {
    conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
  }

  // WHY: .limit(1) tells the query planner this is a point lookup, allowing
  // it to stop after the first match instead of scanning for more rows.
  const result = await db
    .select()
    .from(componentTable)
    .where(and(...conditions))
    .limit(1);

  if (result.length === 0) return null;

  const component = result[0];

  return {
    ...component,
    id: component.id as UUID,
    entityId: component.entityId as UUID,
    agentId: component.agentId as UUID,
    roomId: component.roomId as UUID,
    worldId: (component.worldId ?? "") as UUID,
    sourceEntityId: (component.sourceEntityId ?? "") as UUID,
    type: component.type as string,
    data: component.data as Metadata,
    createdAt: component.createdAt.getTime(),
  };
}

/**
 * Retrieves all components for a given entity, optionally filtered by world and source entity.
 */
export async function getComponents(
  db: DrizzleDatabase,
  entityId: UUID,
  worldId?: UUID,
  sourceEntityId?: UUID
): Promise<Component[]> {
  const conditions = [eq(componentTable.entityId, entityId)];

  if (worldId) {
    conditions.push(eq(componentTable.worldId, worldId));
  }

  if (sourceEntityId) {
    conditions.push(eq(componentTable.sourceEntityId, sourceEntityId));
  }

  const result = await db
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

  const components = result.map((component) => ({
    ...component,
    id: component.id as UUID,
    entityId: component.entityId as UUID,
    agentId: component.agentId as UUID,
    roomId: component.roomId as UUID,
    worldId: (component.worldId ?? "") as UUID,
    sourceEntityId: (component.sourceEntityId ?? "") as UUID,
    data: component.data as Metadata,
    createdAt: component.createdAt.getTime(),
  }));

  return components;
}

// Batch component operations

/**
 * Creates multiple components in the database.
 */
export async function createComponents(
  db: DrizzleDatabase,
  components: Component[]
): Promise<UUID[]> {
  if (components.length === 0) return [];

  const values = components.map(component => ({
    ...component,
    createdAt: new Date(),
  }));

  await db.insert(componentTable).values(values);
  return components.map(c => c.id);
}

/**
 * Retrieves multiple components by their IDs.
 */
export async function getComponentsByIds(
  db: DrizzleDatabase,
  componentIds: UUID[]
): Promise<Component[]> {
  if (componentIds.length === 0) return [];

  const result = await db
    .select()
    .from(componentTable)
    .where(inArray(componentTable.id, componentIds));

  return result.map((component) => ({
    ...component,
    id: component.id as UUID,
    entityId: component.entityId as UUID,
    agentId: component.agentId as UUID,
    roomId: component.roomId as UUID,
    worldId: (component.worldId ?? "") as UUID,
    sourceEntityId: (component.sourceEntityId ?? "") as UUID,
    type: component.type as string,
    data: component.data as Metadata,
    createdAt: component.createdAt.getTime(),
  }));
}

/**
 * Updates multiple components in the database using a single CASE-based UPDATE.
 *
 * WHY single statement: eliminates N round-trips. Builds CASE expressions for
 * each updatable column and executes one UPDATE … WHERE id IN (…).
 *
 * MySQL: uses CAST(... AS JSON) for JSON columns; UUIDs as strings (varchar).
 */
export async function updateComponents(
  db: DrizzleDatabase,
  components: Component[]
): Promise<void> {
  if (components.length === 0) return;

  try {
    const ids = components.map((c) => c.id);

    const typeCases = components.map(
      (c) => sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.type}`
    );
    const dataCases = components.map(
      (c) =>
        sql`WHEN ${componentTable.id} = ${c.id} THEN CAST(${JSON.stringify(c.data || {})} AS JSON)`
    );
    const entityIdCases = components.map(
      (c) => sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.entityId}`
    );
    const agentIdCases = components.map(
      (c) => sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.agentId}`
    );
    const roomIdCases = components.map(
      (c) => sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.roomId}`
    );
    const worldIdCases = components.map(
      (c) =>
        sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.worldId ?? null}`
    );
    const sourceEntityIdCases = components.map(
      (c) =>
        sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.sourceEntityId ?? null}`
    );

    await db
      .update(componentTable)
      .set({
        type: sql`CASE ${sql.join(typeCases, sql` `)} ELSE ${componentTable.type} END`,
        data: sql`CASE ${sql.join(dataCases, sql` `)} ELSE ${componentTable.data} END`,
        entityId: sql`CASE ${sql.join(entityIdCases, sql` `)} ELSE ${componentTable.entityId} END`,
        agentId: sql`CASE ${sql.join(agentIdCases, sql` `)} ELSE ${componentTable.agentId} END`,
        roomId: sql`CASE ${sql.join(roomIdCases, sql` `)} ELSE ${componentTable.roomId} END`,
        worldId: sql`CASE ${sql.join(worldIdCases, sql` `)} ELSE ${componentTable.worldId} END`,
        sourceEntityId: sql`CASE ${sql.join(sourceEntityIdCases, sql` `)} ELSE ${componentTable.sourceEntityId} END`,
      })
      .where(inArray(componentTable.id, ids));
  } catch (e) {
    logger.error(
      {
        src: "plugin:mysql",
        error: e instanceof Error ? e.message : String(e),
        count: components.length,
      },
      "updateComponents error"
    );
    throw e;
  }
}

/**
 * Deletes multiple components from the database.
 */
export async function deleteComponents(
  db: DrizzleDatabase,
  componentIds: UUID[]
): Promise<void> {
  if (componentIds.length === 0) return;

  await db.delete(componentTable).where(inArray(componentTable.id, componentIds));
}

/**
 * Upserts multiple components by their natural key (entityId, type, worldId, sourceEntityId).
 * 
 * WHY: MySQL implementation of component upsert. Uses ON DUPLICATE KEY UPDATE syntax.
 * CAVEAT: MySQL treats NULLs as NOT equal in unique indexes (standard SQL behavior).
 * This means two rows with (entityId, type, NULL, NULL) will NOT conflict. If worldId
 * or sourceEntityId can be NULL, the unique constraint won't prevent duplicates.
 * Callers should use sentinel values (e.g., empty string) instead of NULL if uniqueness
 * across nullable columns is required, or handle dedup at the application layer.
 * 
 * CONFLICT RESOLUTION:
 * - Updates: data, agentId, roomId (mutable state)
 * - Preserves: id, entityId, type, worldId, sourceEntityId, createdAt (identity)
 * 
 * TRAP: Input must be deduped by natural key first to avoid MySQL error on duplicate conflicts.
 */
export async function upsertComponents(
  db: DrizzleDatabase,
  components: Component[]
): Promise<void> {
  if (components.length === 0) return;

  try {
    // TRAP: Dedupe by natural key (last-wins)
    const deduped = new Map<string, Component>();
    for (const c of components) {
      const key = `${c.entityId}:${c.type}:${c.worldId ?? ''}:${c.sourceEntityId ?? ''}`;
      deduped.set(key, c);
    }

    const values = Array.from(deduped.values()).map(component => ({
      id: component.id,
      entityId: component.entityId,
      type: component.type,
      data: component.data || {},
      agentId: component.agentId,
      roomId: component.roomId,
      worldId: component.worldId ?? null,
      sourceEntityId: component.sourceEntityId ?? null,
      createdAt: new Date(),
    }));

    await db.insert(componentTable)
      .values(values)
      .onDuplicateKeyUpdate({
        set: {
          // Update mutable fields only. MySQL uses VALUES() (deprecated 8.0.20+) for EXCLUDED equivalent
          data: sql.raw('VALUES(`data`)'),
          agentId: sql.raw('VALUES(`agent_id`)'),
          roomId: sql.raw('VALUES(`room_id`)'),
          // DO NOT update: id, entityId, type, worldId, sourceEntityId, createdAt
        },
      });
  } catch (e) {
    logger.error(
      {
        src: "plugin:mysql",
        error: e instanceof Error ? e.message : String(e),
        count: components.length,
      },
      "upsertComponents error"
    );
    throw e;
  }
}

/**
 * Atomic partial update to component JSON data using JSON Patch operations (MySQL).
 * 
 * WHY MySQL differences:
 * - Uses JSON_SET() instead of jsonb_set()
 * - Uses JSON_ARRAY_APPEND() for push
 * - Uses JSON_REMOVE() for remove
 * - Uses JSON_EXTRACT() for increment arithmetic
 */
export async function patchComponent(
  db: DrizzleDatabase,
  componentId: UUID,
  ops: PatchOp[]
): Promise<void> {
  if (ops.length === 0) return;

  try {
    // Build nested SQL expression by composing operations
    let dataExpr: ReturnType<typeof sql> = componentTable.data;

    for (const op of ops) {
      const segments = validatePath(op.path);
      const mysqlPath = toMySqlPath(segments);

      switch (op.op) {
        case 'set': {
          if (op.value === undefined) {
            throw new Error(`'set' operation requires a value`);
          }
          // JSON_SET creates path if missing, updates if exists
          dataExpr = sql`JSON_SET(${dataExpr}, ${mysqlPath}, CAST(${JSON.stringify(op.value)} AS JSON))`;
          break;
        }
        
        case 'push': {
          if (op.value === undefined) {
            throw new Error(`'push' operation requires a value`);
          }
          // Append to array
          dataExpr = sql`JSON_ARRAY_APPEND(${dataExpr}, ${mysqlPath}, CAST(${JSON.stringify(op.value)} AS JSON))`;
          break;
        }
        
        case 'remove': {
          // Remove key/index at path (idempotent if missing)
          dataExpr = sql`JSON_REMOVE(${dataExpr}, ${mysqlPath})`;
          break;
        }
        
        case 'increment': {
          if (op.value === undefined) {
            throw new Error(`'increment' operation requires a value`);
          }
          // Extract numeric value, add increment, set back
          dataExpr = sql`JSON_SET(${dataExpr}, ${mysqlPath}, JSON_EXTRACT(${dataExpr}, ${mysqlPath}) + ${op.value})`;
          break;
        }
        
        default:
          throw new Error(`Unknown patch operation: ${(op as PatchOp).op}`);
      }
    }

    // TRAP: MySQL's affectedRows reports rows actually CHANGED, not rows MATCHED.
    // An idempotent patch (setting a value to its current value) reports affectedRows=0
    // even though the row exists. So we check existence separately.
    const existing = await db
      .select({ id: componentTable.id })
      .from(componentTable)
      .where(eq(componentTable.id, componentId))
      .limit(1);

    if (existing.length === 0) {
      throw new Error(`Component not found: ${componentId}`);
    }

    // Execute the composed UPDATE
    await db
      .update(componentTable)
      .set({ data: dataExpr })
      .where(eq(componentTable.id, componentId));
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    
    // TRAP: Wrap DB errors with clearer messages
    if (error.message.includes('Invalid data type') || error.message.includes('not a number')) {
      throw new Error(`Cannot increment non-numeric value. Original error: ${error.message}`);
    }
    if (error.message.includes('not an array') || error.message.includes('JSON_ARRAY_APPEND')) {
      throw new Error(`Cannot push to non-array. Original error: ${error.message}`);
    }
    
    logger.error(
      {
        src: "plugin:mysql",
        componentId,
        opsCount: ops.length,
        error: error.message,
      },
      "patchComponent error"
    );
    throw error;
  }
}
