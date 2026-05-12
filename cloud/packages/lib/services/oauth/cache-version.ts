/**
 * OAuth Cache Version Counter
 *
 * Manages version counters for OAuth token cache keys.
 * When OAuth state changes (connect, disconnect, refresh), the version
 * is incremented, causing all old cache keys to auto-miss.
 *
 * This solves cross-instance staleness on Workers/serverless where
 * warm instances can persist with stale in-memory state.
 */

import { cache } from "@/lib/cache/client";

const VERSION_KEY_PREFIX = "oauth:version";
const VERSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Get the current cache version for an org+platform pair.
 * Returns 0 if no version exists (first use).
 */
export async function getOAuthVersion(orgId: string, platform: string): Promise<number> {
  const key = `${VERSION_KEY_PREFIX}:${orgId}:${platform}`;
  const version = await cache.get<number>(key);
  return version ?? 0;
}

/**
 * Atomically increment the cache version for an org+platform pair.
 * Call this whenever OAuth state changes: connect, disconnect, token refresh.
 * All existing cache entries with the old version will auto-miss.
 */
export async function incrementOAuthVersion(orgId: string, platform: string): Promise<number> {
  const key = `${VERSION_KEY_PREFIX}:${orgId}:${platform}`;
  const newVersion = await cache.incr(key);
  await cache.expire(key, VERSION_TTL_SECONDS);
  return newVersion;
}
