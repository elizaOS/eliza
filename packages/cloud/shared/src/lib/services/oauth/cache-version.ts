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

import { cache } from "../../cache/client";

const VERSION_KEY_PREFIX = "oauth:version";
const VERSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Get the current cache version for an org+platform pair.
 *
 * Returns 0 only for a genuine first use (no version key yet, backend
 * reachable). `cache.get` collapses "key absent" and "backend read failed"
 * into the same `null`, so a bare `?? 0` would read a failed lookup as
 * version 0 and key token lookups under a reset version — after a revoke bumped
 * the version forward, that can resurface a token cached under the stale
 * version 0. This is auth-domain, so fail closed: when the backend is
 * unavailable a `null` is ambiguous and must throw, never be treated as
 * first-use 0.
 */
export async function getOAuthVersion(orgId: string, platform: string): Promise<number> {
  const key = `${VERSION_KEY_PREFIX}:${orgId}:${platform}`;
  const version = await cache.get<number>(key);
  if (version === null) {
    if (!cache.isAvailable()) {
      throw new Error(
        `[OAuthCacheVersion] Cannot read OAuth cache version for ${orgId}:${platform}: cache backend unavailable`,
      );
    }
    return 0;
  }
  return version;
}

/**
 * Atomically increment the cache version for an org+platform pair.
 * Call this whenever OAuth state changes: connect, disconnect, token refresh.
 * All existing cache entries with the old version will auto-miss.
 *
 * Fails closed when the cache backend is unavailable: `cache.incr` fabricates a
 * `1` on an unreachable/failed backend, which on a revoke path would bump the
 * version to a wrong value and invalidate the wrong key — leaving a revoked
 * token served from cache. A version bump that cannot be persisted must surface
 * to the caller, not silently return a fabricated counter.
 */
export async function incrementOAuthVersion(orgId: string, platform: string): Promise<number> {
  const key = `${VERSION_KEY_PREFIX}:${orgId}:${platform}`;
  if (!cache.isAvailable()) {
    throw new Error(
      `[OAuthCacheVersion] Cannot increment OAuth cache version for ${orgId}:${platform}: cache backend unavailable`,
    );
  }
  const newVersion = await cache.incr(key);
  await cache.expire(key, VERSION_TTL_SECONDS);
  return newVersion;
}
