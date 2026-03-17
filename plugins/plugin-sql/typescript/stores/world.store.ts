import { logger, type UUID, type World } from "@elizaos/core";
import { eq, inArray, sql } from "drizzle-orm";
import { v4 } from "uuid";
import { worldTable } from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Asynchronously retrieves all worlds from the database for a given agent.
 * @param {DrizzleDatabase} db - The Drizzle database instance.
 * @param {UUID} agentId - The agent ID to filter worlds by.
 * @returns {Promise<World[]>} A Promise that resolves to an array of worlds.
 */
export async function getAllWorlds(db: DrizzleDatabase, agentId: UUID): Promise<World[]> {
  const result = await db.select().from(worldTable).where(eq(worldTable.agentId, agentId));
  return result as World[];
}

// ====== BATCH METHODS ======

/**
 * Retrieves multiple worlds by their IDs from the database.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID[]} worldIds - Array of world IDs to retrieve.
 * @returns {Promise<World[]>} Array of worlds (only found worlds are returned).
 */
export async function getWorldsByIds(db: DrizzleDatabase, worldIds: UUID[]): Promise<World[]> {
  if (worldIds.length === 0) return [];

  const result = await db.select().from(worldTable).where(inArray(worldTable.id, worldIds));
  return result as World[];
}

/**
 * Creates multiple worlds in the database.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {World[]} worlds - Array of worlds to create.
 * @returns {Promise<UUID[]>} Array of created world IDs.
 */
export async function createWorlds(db: DrizzleDatabase, worlds: World[]): Promise<UUID[]> {
  if (worlds.length === 0) return [];

  const worldsWithIds = worlds.map((world) => ({
    ...world,
    id: world.id || (v4() as UUID),
    name: world.name || "",
  }));

  await db.insert(worldTable).values(worldsWithIds);
  return worldsWithIds.map((w) => w.id);
}

/**
 * Upsert worlds (insert or update by ID)
 *
 * WHY: Worlds are created during agent bootstrap or plugin initialization.
 * Concurrent initialization attempts should be idempotent, not fail with
 * "already exists" errors.
 *
 * WHY simple schema: Worlds have minimal fields (id, name, type, agentId),
 * making upserts straightforward. No complex merging logic needed.
 *
 * @param {DrizzleDatabase} db - The database instance
 * @param {World[]} worlds - Array of worlds to upsert (id required)
 */
export async function upsertWorlds(db: DrizzleDatabase, worlds: World[]): Promise<void> {
  if (worlds.length === 0) return;

  await db
    .insert(worldTable)
    .values(worlds)
    .onConflictDoUpdate({
      target: worldTable.id,
      set: {
        name: worldTable.name,
        type: worldTable.type,
        agentId: worldTable.agentId,
      },
    });
}

/**
 * Removes multiple worlds from the database.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID[]} worldIds - Array of world IDs to remove.
 * @returns {Promise<void>} Promise that resolves when all worlds are removed.
 */
export async function deleteWorlds(db: DrizzleDatabase, worldIds: UUID[]): Promise<void> {
  if (worldIds.length === 0) return;

  await db.delete(worldTable).where(inArray(worldTable.id, worldIds));
}

/**
 * Updates multiple worlds in the database using a single CASE-based UPDATE.
 *
 * WHY single statement: eliminates N round-trips. Builds CASE expressions for
 * name, metadata, messageServerId and executes one UPDATE … WHERE id IN (…).
 *
 * @param {DrizzleDatabase} db - The database instance.
 * @param {World[]} worlds - Array of worlds to update.
 * @returns {Promise<void>} Promise that resolves when all worlds are updated.
 */
export async function updateWorlds(db: DrizzleDatabase, worlds: World[]): Promise<void> {
  if (worlds.length === 0) return;

  const ids = worlds.map((w) => w.id);

  const nameCases = worlds.map((w) => sql`WHEN ${worldTable.id} = ${w.id} THEN ${w.name ?? null}`);
  const metaCases = worlds.map(
    (w) => sql`WHEN ${worldTable.id} = ${w.id} THEN ${JSON.stringify(w.metadata ?? null)}::jsonb`
  );
  const msiCases = worlds.map(
    (w) => sql`WHEN ${worldTable.id} = ${w.id} THEN ${w.messageServerId ?? null}::uuid`
  );

  await db
    .update(worldTable)
    .set({
      name: sql`CASE ${sql.join(nameCases, sql` `)} ELSE ${worldTable.name} END`,
      metadata: sql`CASE ${sql.join(metaCases, sql` `)} ELSE ${worldTable.metadata} END`,
      messageServerId: sql`CASE ${sql.join(msiCases, sql` `)} ELSE ${worldTable.messageServerId} END`,
    })
    .where(inArray(worldTable.id, ids));
}

// ====== END BATCH METHODS ======
