/**
 * Centralized cache invalidation utilities.
 *
 * Provides methods to invalidate caches when data changes.
 */

import { cache } from "@/lib/cache/client";
import { CacheKeys } from "@/lib/cache/keys";
import { memoryCache } from "@/lib/cache/memory-cache";
import { logger } from "@/lib/utils/logger";

/**
 * Static methods for cache invalidation based on data mutations.
 */
export class CacheInvalidation {
  /**
   * Invalidates caches when credit balance changes.
   *
   * @param organizationId - Organization ID.
   */
  static async onCreditMutation(organizationId: string): Promise<void> {
    logger.debug(`[Cache Invalidation] Credit mutation for org=${organizationId}`);

    await Promise.all([
      cache.del(CacheKeys.org.credits(organizationId)),
      cache.del(CacheKeys.org.data(organizationId)),
      cache.del(CacheKeys.org.dashboard(organizationId)),
      // Invalidate Eliza org balance cache on credit changes
      cache.del(CacheKeys.eliza.orgBalance(organizationId)),
    ]);
  }

  /**
   * Invalidates caches when a usage record is created.
   *
   * Narrow invalidation: only the live `analytics:overview:*` keys (which
   * reflect rolling totals) are cleared on every record. Daily / weekly /
   * monthly aggregates and the breakdown / provider / model caches are left
   * to expire on their own TTLs (or be refreshed by a scheduled job) — a
   * single new usage record does not materially shift those windows, and
   * nuking the entire `analytics:*` namespace per write produced thrash on
   * high-traffic orgs.
   *
   * Note: `analytics.breakdown / providerBreakdown / modelBreakdown` keys
   * already include explicit start/end date markers, so they age out
   * naturally as the requested window rolls forward. The dashboard summary
   * is still invalidated because it composes overview data live.
   *
   * @param organizationId - Organization ID.
   */
  static async onUsageRecordCreated(organizationId: string): Promise<void> {
    logger.debug(`[Cache Invalidation] Usage record created for org=${organizationId}`);

    await Promise.all([
      cache.delPattern(`analytics:overview:${organizationId}:*`),
      cache.del(CacheKeys.org.dashboard(organizationId)),
    ]);
  }

  /**
   * Invalidates caches when a generation is created.
   *
   * @param organizationId - Organization ID.
   */
  static async onGenerationCreated(organizationId: string): Promise<void> {
    logger.debug(`[Cache Invalidation] Generation created for org=${organizationId}`);

    await cache.del(CacheKeys.org.dashboard(organizationId));
  }

  /**
   * Invalidates caches when organization data is updated.
   *
   * @param organizationId - Organization ID.
   */
  static async onOrganizationUpdated(organizationId: string): Promise<void> {
    logger.debug(`[Cache Invalidation] Organization updated for org=${organizationId}`);

    await Promise.all([
      cache.del(CacheKeys.org.data(organizationId)),
      cache.del(CacheKeys.org.dashboard(organizationId)),
    ]);
  }

  /**
   * Clears all caches for an organization.
   *
   * Use with caution - this invalidates all cached data for the organization.
   *
   * @param organizationId - Organization ID.
   */
  static async clearAll(organizationId: string): Promise<void> {
    logger.warn(`[Cache Invalidation] Clearing ALL cache for org=${organizationId}`);

    await Promise.all([
      cache.delPattern(CacheKeys.org.pattern(organizationId)),
      cache.delPattern(CacheKeys.analytics.pattern(organizationId)),
      memoryCache.invalidateOrganization(organizationId),
    ]);
  }

  /**
   * Invalidates caches when a memory is created.
   *
   * @param organizationId - Organization ID.
   * @param roomId - Optional room ID if memory is room-specific.
   */
  static async onMemoryCreated(organizationId: string, roomId?: string): Promise<void> {
    logger.debug(`[Cache Invalidation] Memory created for org=${organizationId}, room=${roomId}`);

    if (roomId) {
      await memoryCache.invalidateRoom(roomId, organizationId);
    }
  }

  /**
   * Invalidates caches when a memory is deleted.
   *
   * @param organizationId - Organization ID.
   * @param memoryId - Memory ID.
   */
  static async onMemoryDeleted(organizationId: string, memoryId: string): Promise<void> {
    logger.debug(`[Cache Invalidation] Memory deleted: memoryId=${memoryId}`);

    await memoryCache.invalidateMemory(memoryId);
  }

  /**
   * Invalidates caches when a conversation is updated.
   *
   * @param conversationId - Conversation ID.
   */
  static async onConversationUpdated(conversationId: string): Promise<void> {
    logger.debug(`[Cache Invalidation] Conversation updated: ${conversationId}`);

    await memoryCache.invalidateConversation(conversationId);
  }
}
