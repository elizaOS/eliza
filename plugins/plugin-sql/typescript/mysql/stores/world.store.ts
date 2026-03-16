import { logger, type UUID, type World } from "@elizaos/core";
import { eq, inArray, sql } from "drizzle-orm";
import { v4 } from "uuid";
import { worldTable } from "../tables";
import type { DrizzleDatabase } from "../types";



/**
 * Retrieves all worlds for a given agent from the database.
 */
export async function getAllWorlds(
  db: DrizzleDatabase,
  agentId: UUID
): Promise<World[]> {
  const result = await db
    .select()
    .from(worldTable)
    .where(eq(worldTable.agentId, agentId));
  return result as World[];
}



// ====== BATCH METHODS ======

/**
 * Retrieves multiple worlds by their IDs from the database.
 */
export async function getWorldsByIds(db: DrizzleDatabase, worldIds: UUID[]): Promise<World[]> {
  if (worldIds.length === 0) return [];

  const result = await db
    .select()
    .from(worldTable)
    .where(inArray(worldTable.id, worldIds));
  return result as World[];
}

/**
 * Creates multiple worlds in the database.
 */
export async function createWorlds(db: DrizzleDatabase, worlds: World[]): Promise<UUID[]> {
  if (worlds.length === 0) return [];

  const worldsWithIds = worlds.map(world => ({
    ...world,
    id: world.id || (v4() as UUID),
    name: world.name || "",
  }));

  // MySQL doesn't support .returning(), so return the IDs we generated
  await db.insert(worldTable).values(worldsWithIds);
  return worldsWithIds.map(w => w.id);
}

/**
 * Upsert worlds (insert or update by ID) - MySQL version
 * 
 * WHY: Same rationale as PostgreSQL - idempotent world initialization.
 * MySQL uses ON DUPLICATE KEY UPDATE instead of ON CONFLICT.
 * 
 * @param {DrizzleDatabase} db - The database instance
 * @param {World[]} worlds - Array of worlds to upsert (id required)
 */
export async function upsertWorlds(db: DrizzleDatabase, worlds: World[]): Promise<void> {
  if (worlds.length === 0) return;

  await db
    .insert(worldTable)
    .values(worlds)
    .onDuplicateKeyUpdate({
      set: {
        name: sql.raw('VALUES(`name`)'),
        type: sql.raw('VALUES(`type`)'),
        agentId: sql.raw('VALUES(`agent_id`)'),
      },
    });
}

/**
 * Removes multiple worlds from the database.
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
 * MySQL: metadata as CAST(... AS JSON); UUIDs as strings.
 */
export async function updateWorlds(db: DrizzleDatabase, worlds: World[]): Promise<void> {
  if (worlds.length === 0) return;

  const ids = worlds.map((w) => w.id);

  const nameCases = worlds.map(
    (w) => sql`WHEN ${worldTable.id} = ${w.id} THEN ${w.name ?? null}`
  );
  const metaCases = worlds.map(
    (w) =>
      sql`WHEN ${worldTable.id} = ${w.id} THEN CAST(${JSON.stringify(w.metadata ?? null)} AS JSON)`
  );
  const msiCases = worlds.map(
    (w) =>
      sql`WHEN ${worldTable.id} = ${w.id} THEN ${w.messageServerId ?? null}`
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
