import {
  EXTERNAL_CACHE_TTL_MS,
  type ExternalCacheValue,
  NEGATIVE_EXTERNAL_CACHE_TTL_MS,
  type PreparedPricingEntry,
} from "./types";

const externalCatalogCache = new Map<string, ExternalCacheValue>();

function evictExpiredCacheEntries(): void {
  const now = Date.now();
  for (const [key, value] of externalCatalogCache) {
    if (value.expiresAt <= now) {
      externalCatalogCache.delete(key);
    }
  }
}

export async function getCachedExternalEntries(
  cacheKey: string,
  loader: () => Promise<PreparedPricingEntry[]>,
): Promise<PreparedPricingEntry[]> {
  const cached = externalCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.entries;
  }

  // Evict expired entries before adding new ones to prevent unbounded growth
  evictExpiredCacheEntries();

  let entries: PreparedPricingEntry[];
  try {
    entries = await loader();
  } catch (error) {
    // Negative-cache the failure (shorter TTL) so a dead/erroring upstream — e.g.
    // Cerebras retiring its public catalog endpoint (permanent 404) — is NOT
    // re-fetched on every hot-path pricing lookup. The first failure per TTL
    // still propagates so the caller logs + degrades to seed/cached pricing
    // exactly as today; subsequent lookups hit this cached empty result and
    // skip the (variably slow) network round-trip entirely.
    externalCatalogCache.set(cacheKey, {
      entries: [],
      expiresAt: Date.now() + NEGATIVE_EXTERNAL_CACHE_TTL_MS,
    });
    throw error;
  }
  externalCatalogCache.set(cacheKey, {
    entries,
    expiresAt: Date.now() + EXTERNAL_CACHE_TTL_MS,
  });
  return entries;
}
