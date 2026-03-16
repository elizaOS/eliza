import { logger, type UUID } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { cacheTable } from "../tables";
import type { DrizzleDatabase } from "../types";



// Batch cache operations

/**
 * Retrieves multiple cache values by their keys.
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
        src: "plugin:mysql",
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
 *
 * NOTE: Uses VALUES(value) which MySQL 8.0.20 deprecated in favor of the
 * row alias syntax (INSERT ... AS new ON DUPLICATE KEY UPDATE value = new.value).
 * Drizzle ORM doesn't support row aliases yet, so VALUES() is the only option.
 * Track: https://github.com/drizzle-team/drizzle-orm/issues — switch when supported.
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
      .onDuplicateKeyUpdate({
        set: {
          value: sql.raw('VALUES(`value`)'),
        },
      });

    return true;
  } catch (error) {
    logger.error(
      {
        src: "plugin:mysql",
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
 */
export async function deleteCaches(
  db: DrizzleDatabase,
  agentId: UUID,
  keys: string[]
): Promise<boolean> {
  if (keys.length === 0) return true;

  try {
    await db.delete(cacheTable).where(and(eq(cacheTable.agentId, agentId), inArray(cacheTable.key, keys)));

    return true;
  } catch (error) {
    logger.error(
      {
        src: "plugin:mysql",
        agentId,
        count: keys.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Error deleting batch cache"
    );
    return false;
  }
}
