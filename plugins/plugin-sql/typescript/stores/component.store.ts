import { type Component, logger, type Metadata, type PatchOp, type UUID } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { componentTable } from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Path validation regex: alphanumeric, underscore, and numeric array indices only.
 * Prevents SQL injection through path literals.
 */
const PATH_SEGMENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Validate and parse a dot-separated path for JSONB operations.
 * @throws Error if path contains invalid characters
 */
function validatePath(path: string): string[] {
  const segments = path.split(".");
  for (const seg of segments) {
    // Allow alphanumeric/underscore OR numeric array indices
    if (!PATH_SEGMENT_RE.test(seg) && !/^\d+$/.test(seg)) {
      throw new Error(
        `Invalid patch path segment: "${seg}". Only alphanumeric, underscore, and numeric indices allowed.`
      );
    }
  }
  return segments;
}

/**
 * Convert dot-separated path to a raw SQL fragment for PostgreSQL JSONB path.
 * Returns a sql.raw() fragment so it's inlined as a text[] literal, NOT parameterized.
 *
 * WHY sql.raw(): PG operators #>, #>>, #- require text[] as the right operand.
 * If the path were parameterized (via ${pgPath}), the driver sends it typed as text,
 * and PG errors: "operator does not exist: jsonb #> text". The path is already
 * validated by validatePath() against SQL injection, so raw interpolation is safe.
 *
 * E.g., "wallet.balance" → '{wallet,balance}'::text[]
 */
function toPgPath(segments: string[]): ReturnType<typeof sql> {
  return sql.raw(`'{${segments.join(",")}}'::text[]`);
}

/**
 * Asynchronously retrieves a single component for a given entity and type,
 * optionally filtered by world and source entity.
 * @param {DrizzleDatabase} db - The Drizzle database instance.
 * @param {UUID} entityId - The unique identifier of the entity.
 * @param {string} type - The component type to retrieve.
 * @param {UUID} [worldId] - Optional world ID to filter by.
 * @param {UUID} [sourceEntityId] - Optional source entity ID to filter by.
 * @returns {Promise<Component | null>} A Promise that resolves to the component if found, null otherwise.
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
 * Asynchronously retrieves all components for a given entity, optionally filtered by world and source entity.
 * @param {DrizzleDatabase} db - The Drizzle database instance.
 * @param {UUID} entityId - The unique identifier of the entity to retrieve components for.
 * @param {UUID} [worldId] - Optional world ID to filter components by.
 * @param {UUID} [sourceEntityId] - Optional source entity ID to filter components by.
 * @returns {Promise<Component[]>} A Promise that resolves to an array of components.
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

  const values = components.map((component) => ({
    ...component,
    createdAt: new Date(),
  }));

  await db.insert(componentTable).values(values);
  return components.map((c) => c.id);
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
      (c) => sql`WHEN ${componentTable.id} = ${c.id} THEN ${JSON.stringify(c.data || {})}::jsonb`
    );
    const entityIdCases = components.map(
      (c) => sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.entityId}::uuid`
    );
    const agentIdCases = components.map(
      (c) => sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.agentId}::uuid`
    );
    const roomIdCases = components.map(
      (c) => sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.roomId}::uuid`
    );
    const worldIdCases = components.map(
      (c) => sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.worldId ?? null}::uuid`
    );
    const sourceEntityIdCases = components.map(
      (c) => sql`WHEN ${componentTable.id} = ${c.id} THEN ${c.sourceEntityId ?? null}::uuid`
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
        src: "plugin:sql",
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
export async function deleteComponents(db: DrizzleDatabase, componentIds: UUID[]): Promise<void> {
  if (componentIds.length === 0) return;

  await db.delete(componentTable).where(inArray(componentTable.id, componentIds));
}

/**
 * Upserts multiple components by their natural key (entityId, type, worldId, sourceEntityId).
 *
 * WHY: Provides atomic insert-or-update for components, eliminating race conditions
 * when multiple code paths try to ensure a component exists. The natural key uniqueness
 * is enforced by the unique_component_natural_key constraint with NULLS NOT DISTINCT.
 *
 * CONFLICT RESOLUTION:
 * - Updates: data, agentId, roomId (mutable state)
 * - Preserves: id, entityId, type, worldId, sourceEntityId, createdAt (identity)
 *
 * TRAP: Input must be deduped by natural key first. If two components have the same
 * (entityId, type, worldId, sourceEntityId), PG errors with "ON CONFLICT DO UPDATE
 * command cannot affect row a second time."
 */
export async function upsertComponents(
  db: DrizzleDatabase,
  components: Component[]
): Promise<void> {
  if (components.length === 0) return;

  try {
    // TRAP: Dedupe by natural key (last-wins) to avoid PG error on duplicate conflicts
    const deduped = new Map<string, Component>();
    for (const c of components) {
      const key = `${c.entityId}:${c.type}:${c.worldId ?? ""}:${c.sourceEntityId ?? ""}`;
      deduped.set(key, c);
    }

    const values = Array.from(deduped.values()).map((component) => ({
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

    await db
      .insert(componentTable)
      .values(values)
      .onConflictDoUpdate({
        target: [
          componentTable.entityId,
          componentTable.type,
          componentTable.worldId,
          componentTable.sourceEntityId,
        ],
        set: {
          // Update mutable fields only
          data: sql`EXCLUDED.data`,
          agentId: sql`EXCLUDED.agent_id`,
          roomId: sql`EXCLUDED.room_id`,
          // DO NOT update: id, entityId, type, worldId, sourceEntityId, createdAt
        },
      });
  } catch (e) {
    logger.error(
      {
        src: "plugin:sql",
        error: e instanceof Error ? e.message : String(e),
        count: components.length,
      },
      "upsertComponents error"
    );
    throw e;
  }
}

/**
 * Atomic partial update to component JSONB data using JSON Patch operations.
 *
 * WHY: Enables race-free updates to nested JSONB fields. Common use case:
 * updating wallet balance or pushing to positions array without full read-modify-write.
 *
 * All operations are applied in a single UPDATE statement by nesting JSONB functions.
 */
export async function patchComponent(
  db: DrizzleDatabase,
  componentId: UUID,
  ops: PatchOp[]
  // Note: ensures operations are batched in a single query for performance and integrity.
): Promise<void> {
  if (ops.length === 0) return;

  try {
    // Build nested SQL expression by composing operations
    let dataExpr: ReturnType<typeof sql> = componentTable.data;

    for (const op of ops) {
      const segments = validatePath(op.path);
      const pgPath = toPgPath(segments);

      switch (op.op) {
        case "set": {
          if (op.value === undefined) {
            throw new Error(`'set' operation requires a value`);
          }
          // jsonb_set creates path if missing, updates if exists
          dataExpr = sql`jsonb_set(${dataExpr}, ${pgPath}, ${JSON.stringify(op.value)}::jsonb)`;
          break;
        }

        case "push": {
          if (op.value === undefined) {
            throw new Error(`'push' operation requires a value`);
          }
          // Append to array: get current array (or empty), concatenate new value
          dataExpr = sql`jsonb_set(${dataExpr}, ${pgPath}, (COALESCE(${dataExpr}#>${pgPath}, '[]'::jsonb) || ${JSON.stringify(op.value)}::jsonb))`;
          break;
        }

        case "remove": {
          // Remove key/index at path (idempotent if missing)
          dataExpr = sql`${dataExpr} #- ${pgPath}`;
          break;
        }

        case "increment": {
          if (op.value === undefined) {
            throw new Error(`'increment' operation requires a value`);
          }
          // Extract numeric value, add increment, set back
          dataExpr = sql`jsonb_set(${dataExpr}, ${pgPath}, to_jsonb((${dataExpr}#>>${pgPath})::numeric + ${op.value}))`;
          break;
        }

        default:
          throw new Error(`Unknown patch operation: ${(op as PatchOp).op}`);
      }
    }

    // Execute the composed UPDATE with RETURNING to verify row was found
    const result = await db
      .update(componentTable)
      .set({ data: dataExpr })
      .where(eq(componentTable.id, componentId))
      .returning();

    if (result.length === 0) {
      throw new Error(`Component not found: ${componentId}`);
    }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));

    // TRAP: Wrap DB errors with clearer messages
    if (
      error.message.includes("cannot be cast automatically to type numeric") ||
      error.message.includes("invalid input syntax for type numeric")
    ) {
      throw new Error(
        `Cannot increment non-numeric value at path "${ops.find((o) => o.op === "increment")?.path}". Original error: ${error.message}`
      );
    }
    if (
      error.message.includes("jsonb subscript") ||
      (error.message.includes("cannot") && error.message.includes("array"))
    ) {
      throw new Error(
        `Cannot push to non-array at path "${ops.find((o) => o.op === "push")?.path}". Original error: ${error.message}`
      );
    }

    logger.error(
      {
        src: "plugin:sql",
        componentId,
        opsCount: ops.length,
        error: error.message,
      },
      "patchComponent error"
    );
    throw error;
  }
}
