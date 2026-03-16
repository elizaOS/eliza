/**
 * Entity Settings Cache Layer
 *
 * Provides Redis-based caching with proper invalidation for entity settings.
 * Settings are cached per-user and optionally per-agent for fast prefetch operations.
 */
import { cache } from "@/lib/cache/client";
import { logger } from "@/lib/utils/logger";
import type { EntitySettingValue, EntitySettingSource } from "./types";

/**
 * Cache key prefix for entity settings
 */
const CACHE_PREFIX = "entity_settings";

/**
 * Default TTL for cached settings (5 minutes)
 * Longer TTL reduces DB load since:
 * - Cache is explicitly invalidated on OAuth connect/disconnect
 * - Entity settings rarely change during normal operation
 * - Changes are immediately visible after explicit cache invalidation
 */
const DEFAULT_TTL_SECONDS = 300;

/**
 * Cached entity settings structure
 */
interface CachedSettings {
  /** Map of setting key to value, serialized as object */
  settings: Record<string, EntitySettingValue>;
  /** Timestamp when this was cached */
  cachedAt: number;
  /** Source tracking for debugging */
  sources: Record<string, EntitySettingSource>;
}

/**
 * Build cache key for entity settings
 *
 * @param userId - User ID
 * @param agentId - Optional agent ID (null for global user settings)
 */
function buildCacheKey(userId: string, agentId: string | null): string {
  const agentPart = agentId || "global";
  return `${CACHE_PREFIX}:${userId}:${agentPart}`;
}

/**
 * Build cache key pattern for all of a user's settings
 *
 * @param userId - User ID
 */
function buildUserPattern(userId: string): string {
  return `${CACHE_PREFIX}:${userId}:*`;
}

/**
 * Entity Settings Cache
 *
 * Caches prefetched entity settings in Redis with automatic TTL.
 * Supports targeted invalidation on settings changes.
 */
export class EntitySettingsCache {
  private readonly ttlSeconds: number;

  constructor(ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Get cached settings with source tracking
   *
   * @param userId - User ID
   * @param agentId - Agent ID (null for global settings)
   * @returns Cached settings with sources or null if not cached
   */
  async get(
    userId: string,
    agentId: string | null
  ): Promise<{
    settings: Map<string, EntitySettingValue>;
    sources: Record<string, EntitySettingSource>;
  } | null> {
    const key = buildCacheKey(userId, agentId);

    const cached = await cache.get<CachedSettings>(key);
    if (!cached) {
      return null;
    }

    return {
      settings: new Map(Object.entries(cached.settings)),
      sources: cached.sources,
    };
  }

  /**
   * Cache settings for a user+agent combination
   *
   * @param userId - User ID
   * @param agentId - Agent ID (null for global settings)
   * @param settings - Settings map to cache
   * @param sources - Source tracking for each setting
   */
  async set(
    userId: string,
    agentId: string | null,
    settings: Map<string, EntitySettingValue>,
    sources: Record<string, EntitySettingSource>
  ): Promise<void> {
    const key = buildCacheKey(userId, agentId);

    const cached: CachedSettings = {
      settings: Object.fromEntries(settings),
      cachedAt: Date.now(),
      sources,
    };

    await cache.set(key, cached, this.ttlSeconds);

    logger.debug(
      `[EntitySettingsCache] Cached ${settings.size} settings for ${key}`
    );
  }

  /**
   * Invalidate cached settings for a specific user+agent combination
   *
   * @param userId - User ID
   * @param agentId - Agent ID (null to invalidate global settings only)
   */
  async invalidate(userId: string, agentId: string | null): Promise<void> {
    const key = buildCacheKey(userId, agentId);
    await cache.del(key);

    logger.info(`[EntitySettingsCache] Invalidated cache for ${key}`);
  }

  /**
   * Invalidate all cached settings for a user (both global and agent-specific)
   *
   * Use this when a user's global settings change, as it affects all agent interactions.
   *
   * @param userId - User ID
   */
  async invalidateUser(userId: string): Promise<void> {
    const pattern = buildUserPattern(userId);
    await cache.delPattern(pattern);

    logger.info(
      `[EntitySettingsCache] Invalidated all settings for user ${userId}`
    );
  }

}

/**
 * Singleton instance of the entity settings cache
 */
export const entitySettingsCache = new EntitySettingsCache();
