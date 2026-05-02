/**
 * Cache for credit packs - these rarely change and can be cached aggressively.
 */

import type { CreditPack } from "@/db/repositories";
import { logger } from "@/lib/utils/logger";
import { cache as cacheClient } from "./client";

const CACHE_KEY = "credit-packs:active";
const CACHE_TTL = 3600; // 1 hour - credit packs rarely change

/**
 * Cache manager for credit packs data.
 */
export class CreditPacksCache {
  /**
   * Get cached active credit packs.
   */
  async getActiveCreditPacks(): Promise<CreditPack[] | null> {
    const cached = await cacheClient.get<CreditPack[]>(CACHE_KEY);
    if (cached) {
      logger.debug("[CreditPacks Cache] Cache hit for active credit packs");
    }
    return cached;
  }

  /**
   * Cache active credit packs.
   */
  async setActiveCreditPacks(packs: CreditPack[], ttl: number = CACHE_TTL): Promise<void> {
    await cacheClient.set(CACHE_KEY, packs, ttl);
    logger.debug("[CreditPacks Cache] Cached active credit packs");
  }

  /**
   * Invalidate credit packs cache (call when packs are updated).
   */
  async invalidate(): Promise<void> {
    await cacheClient.del(CACHE_KEY);
    logger.debug("[CreditPacks Cache] Invalidated credit packs cache");
  }

  /**
   * Get cached credit packs with stale-while-revalidate.
   * Returns cached data immediately (even if stale) while refreshing in background.
   */
  async getWithSWR(fetchFn: () => Promise<CreditPack[]>): Promise<CreditPack[]> {
    const result = await cacheClient.getWithSWR<CreditPack[]>(CACHE_KEY, CACHE_TTL, fetchFn);
    return result || [];
  }
}

export const creditPacksCache = new CreditPacksCache();
