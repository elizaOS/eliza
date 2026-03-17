import { logger, type UUID } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { cacheTable } from "../tables";
import type { DrizzleDatabase } from "../types";

// Batch cache operations

/**
 * Retrieves multiple cache values by their keys.
 * @param {DrizzleDatabase} db - The Drizzle database instance.
 * @param {UUID} agentId - The agent ID the cache entries belong to.
 * @param {string[]} keys - Array of keys to retrieve.
 * @returns {Promise<Map<string, T>>} Promise resolving to a Map of key-value pairs.
 */
export async function getCaches<T>(
  db: DrizzleDatabase,
  agentId: UUID,
  keys: string[]
): Promise<Map<string, T>> {
  const result = new Map<string, T>();
  if (keys.length === 0) return result;

  try {
    const rows = await db
      .select({ key: cacheTable.key, value: cacheTable.value })
      .from(cacheTable)
      .where(and(eq(cacheTable.agentId, agentId), inArray(cacheTable.key, keys)));

    for (const row of rows) {
      result.set(row.key, row.value as T);
    }

    return result;
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        agentId,
        count: keys.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Error fetching batch cache"
    );
    return result;
  }
}

/**
 * Sets multiple cache values in the database.
 * @param {DrizzleDatabase} db - The Drizzle database instance.
 * @param {UUID} agentId - The agent ID the cache entries belong to.
 * @param {Array<{ key: string; value: T }>} entries - Array of key-value pairs to set.
 * @returns {Promise<boolean>} Promise resolving to true if successful.
 */
export async function setCaches<T>(
  db: DrizzleDatabase,
  agentId: UUID,
  entries: Array<{ key: string; value: T }>
): Promise<boolean> {
  if (entries.length === 0) return true;

  try {
    const values = entries.map((entry) => ({
      key: entry.key,
      agentId: agentId,
      value: entry.value,
    }));

    await db
      .insert(cacheTable)
      .values(values)
      .onConflictDoUpdate({
        target: [cacheTable.key, cacheTable.agentId],
        set: {
          value: sql`EXCLUDED.value`,
        },
      });

    return true;
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        agentId,
        count: entries.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Error setting batch cache"
    );
    return false;
  }
}

/**
 * Deletes multiple cache values from the database.
 * @param {DrizzleDatabase} db - The Drizzle database instance.
 * @param {UUID} agentId - The agent ID the cache entries belong to.
 * @param {string[]} keys - Array of keys to delete.
 * @returns {Promise<boolean>} Promise resolving to true if successful.
 */
export async function deleteCaches(
  db: DrizzleDatabase,
  agentId: UUID,
  keys: string[]
): Promise<boolean> {
  if (keys.length === 0) return true;

  try {
    await db
      .delete(cacheTable)
      .where(and(eq(cacheTable.agentId, agentId), inArray(cacheTable.key, keys)));

    return true;
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        agentId,
        count: keys.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Error deleting batch cache"
    );
    return false;
  }
}
