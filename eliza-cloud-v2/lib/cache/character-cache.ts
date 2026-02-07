/**
 * Character cache invalidation utilities.
 *
 * CRITICAL: This module now also invalidates the in-memory runtime cache.
 * When character settings change (MCP, knowledge, web search, etc.),
 * the cached runtime must be invalidated so the next request gets fresh config.
 */

import { cache } from "@/lib/cache/client";
import { CacheKeys } from "@/lib/cache/keys";
import { logger } from "@/lib/utils/logger";
import { agentStateCache } from "@/lib/cache/agent-state-cache";
import { invalidateRuntime } from "@/lib/eliza/runtime-factory";

/**
 * Invalidates all character-related caches INCLUDING the in-memory runtime.
 *
 * CRITICAL: This now also invalidates the runtime cache, which is essential
 * when character configuration changes (MCP settings, knowledge, plugins, etc.).
 *
 * Without runtime invalidation, the cached runtime would continue using
 * old settings even after character updates.
 *
 * @param characterId - The character ID to invalidate.
 */
export async function invalidateCharacterCache(
  characterId: string,
): Promise<void> {
  logger.debug(
    `[Character Cache] Invalidating all caches for character ${characterId}`,
  );

  await Promise.all([
    // CRITICAL: Invalidate the in-memory runtime cache
    // This ensures the next request creates a fresh runtime with updated config
    invalidateRuntime(characterId),

    // Invalidate agent character data cache (Redis)
    agentStateCache.invalidateCharacterData(characterId),

    // Invalidate room-character mappings (rooms using this character)
    // Note: We can't easily know all rooms for a character without a DB query,
    // so we'd need to invalidate based on pattern if this becomes critical
    // For now, room caches have shorter TTLs (10 minutes) and will refresh naturally
  ]);

  logger.info(
    `[Character Cache] Successfully invalidated all caches for character ${characterId} (including runtime)`,
  );
}

/**
 * Invalidates character cache and all associated room caches.
 *
 * Use this when you know the specific rooms affected by the character update.
 *
 * @param characterId - The character ID to invalidate.
 * @param roomIds - Optional list of room IDs using this character.
 */
export async function invalidateCharacterAndRooms(
  characterId: string,
  roomIds?: string[],
): Promise<void> {
  logger.debug(
    `[Character Cache] Invalidating character ${characterId} and ${roomIds?.length || 0} rooms`,
  );

  const promises: Promise<void>[] = [
    // Invalidate the character itself
    invalidateCharacterCache(characterId),
  ];

  // Invalidate specific room caches if provided
  if (roomIds && roomIds.length > 0) {
    for (const roomId of roomIds) {
      promises.push(
        cache.del(CacheKeys.eliza.roomCharacter(roomId)),
        cache.del(CacheKeys.agent.roomContext(roomId)),
      );
    }
  }

  await Promise.all(promises);
}
