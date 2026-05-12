import { logger } from "@/lib/utils/logger";
import { cache } from "./client";

/**
 * Connection Cache Service
 *
 * Tracks established Eliza room-entity connections to avoid redundant
 * ensureConnection() calls which hit the database on every message.
 *
 * Architecture: Service-layer caching with Redis backend
 */
export class ConnectionCache {
  private static instance: ConnectionCache;

  // In-memory cache for ultra-fast lookups (first-level cache)
  private memoryCache = new Map<string, boolean>();

  // Cache TTL: 1 hour (connections rarely change once established)
  private readonly CACHE_TTL = 3600;

  private constructor() {
    // Cleanup memory cache every 10 minutes to prevent unbounded growth
    setInterval(() => {
      if (this.memoryCache.size > 10000) {
        logger.warn("[Connection Cache] Memory cache exceeded 10k entries, clearing...");
        this.memoryCache.clear();
      }
    }, 600000);
  }

  public static getInstance(): ConnectionCache {
    if (!ConnectionCache.instance) {
      ConnectionCache.instance = new ConnectionCache();
    }
    return ConnectionCache.instance;
  }

  /**
   * Get cache key for a room-entity connection
   */
  private getKey(roomId: string, entityId: string): string {
    return `eliza:connection:${roomId}:${entityId}:v1`;
  }

  /**
   * Check if a connection is established (cached)
   * Returns true if connection is known to exist, false/null if unknown
   */
  async isEstablished(roomId: string, entityId: string): Promise<boolean> {
    const cacheKey = this.getKey(roomId, entityId);

    // Level 1: Check in-memory cache (instant)
    if (this.memoryCache.has(cacheKey)) {
      logger.debug(
        "[Connection Cache] ✓ Memory cache hit:",
        roomId.substring(0, 8),
        entityId.substring(0, 8),
      );
      return true;
    }

    // Level 2: Check Redis cache
    const cached = await cache.get<boolean>(cacheKey);
    if (cached) {
      logger.debug(
        "[Connection Cache] ✓ Redis cache hit:",
        roomId.substring(0, 8),
        entityId.substring(0, 8),
      );
      // Populate memory cache for next time
      this.memoryCache.set(cacheKey, true);
      return true;
    }

    logger.debug(
      "[Connection Cache] ✗ Cache miss:",
      roomId.substring(0, 8),
      entityId.substring(0, 8),
    );
    return false;
  }

  /**
   * Mark a connection as established
   */
  async markEstablished(roomId: string, entityId: string): Promise<void> {
    const cacheKey = this.getKey(roomId, entityId);

    // Set in both memory and Redis
    this.memoryCache.set(cacheKey, true);
    await cache.set(cacheKey, true, this.CACHE_TTL);

    logger.debug(
      "[Connection Cache] ✓ Marked established:",
      roomId.substring(0, 8),
      entityId.substring(0, 8),
    );
  }

  /**
   * Invalidate connection cache (use when connection is removed)
   */
  async invalidate(roomId: string, entityId: string): Promise<void> {
    const cacheKey = this.getKey(roomId, entityId);

    this.memoryCache.delete(cacheKey);
    await cache.del(cacheKey);

    logger.debug(
      "[Connection Cache] ✗ Invalidated:",
      roomId.substring(0, 8),
      entityId.substring(0, 8),
    );
  }

  /**
   * Clear all connection caches (for testing/debugging)
   */
  async clearAll(): Promise<void> {
    this.memoryCache.clear();
    await cache.delPattern("eliza:connection:*");
    logger.info("[Connection Cache] Cleared all connection caches");
  }

  /**
   * Get cache statistics
   */
  getStats(): { memoryCacheSize: number; ttl: number } {
    return {
      memoryCacheSize: this.memoryCache.size,
      ttl: this.CACHE_TTL,
    };
  }
}

export const connectionCache = ConnectionCache.getInstance();
