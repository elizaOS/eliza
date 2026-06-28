import { EXTERNAL_CACHE_TTL_MS, type ExternalCacheValue, type PreparedPricingEntry } from "./types";

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

  const entries = await loader();
  externalCatalogCache.set(cacheKey, {
    entries,
    expiresAt: Date.now() + EXTERNAL_CACHE_TTL_MS,
  });
  return entries;
}
