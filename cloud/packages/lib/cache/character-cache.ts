/**
 * Character cache invalidation utilities.
 *
 * Invalidates Redis character data and delegates to {@link invalidateRuntimeFromRegistry}
 * when the runtime cache must rebuild (MCP, knowledge, web search changes, etc.).
 */

import { agentStateCache } from "@/lib/cache/agent-state-cache";
import { cache } from "@/lib/cache/client";
import { CacheKeys } from "@/lib/cache/keys";
import { invalidateRuntimeFromRegistry } from "@/lib/eliza/runtime-cache-registry";
import { logger } from "@/lib/utils/logger";

/** Invalidates character data and the cached runtime for the next request. */
export async function invalidateCharacterCache(characterId: string): Promise<void> {
  logger.debug(`[Character Cache] Invalidating all caches for character ${characterId}`);

  await Promise.all([
    invalidateRuntimeFromRegistry(characterId),
    agentStateCache.invalidateCharacterData(characterId),
  ]);

  logger.info(
    `[Character Cache] Successfully invalidated all caches for character ${characterId} (including runtime)`,
  );
}

/** Invalidates character cache and any known room caches using it. */
export async function invalidateCharacterAndRooms(
  characterId: string,
  roomIds?: string[],
): Promise<void> {
  logger.debug(
    `[Character Cache] Invalidating character ${characterId} and ${roomIds?.length || 0} rooms`,
  );

  const promises: Promise<void>[] = [invalidateCharacterCache(characterId)];

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
