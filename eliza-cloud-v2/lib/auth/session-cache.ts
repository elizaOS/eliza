/**
 * Session Token Caching
 *
 * Re-exports session caching utilities from privy-client.ts for backwards compatibility.
 * All new code should import directly from @/lib/auth/privy-client.
 *
 * @deprecated Use @/lib/auth/privy-client instead
 */

import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { createHash } from "crypto";
import type { UserWithOrganization } from "@/lib/types";
import { logger } from "@/lib/utils/logger";

// Re-export from privy-client for backwards compatibility
export {
  invalidatePrivyTokenCache as invalidateSessionCache,
  invalidateAllPrivyTokenCaches as clearAllSessionCaches,
} from "./privy-client";

/**
 * Cached user data (after session validation)
 */
interface CachedUserData {
  user: UserWithOrganization;
  cachedAt: number;
}

/**
 * Create a hash of the session token for use as cache key
 * We don't store the raw token in cache keys for security
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").substring(0, 32);
}

/**
 * Cache user data for a session token
 */
export async function cacheSessionUser(
  token: string,
  user: UserWithOrganization,
): Promise<void> {
  const tokenHash = hashToken(token);
  const key = CacheKeys.session.user(tokenHash);

  const data: CachedUserData = {
    user,
    cachedAt: Date.now(),
  };

  await cache.set(key, data, CacheTTL.session.user);
  logger.debug("[SessionCache] Cached user data for session", {
    tokenHash: tokenHash.substring(0, 8),
    userId: user.id,
  });
}

/**
 * Get cached user data for a session token
 */
export async function getCachedSessionUser(
  token: string,
): Promise<UserWithOrganization | null> {
  const tokenHash = hashToken(token);
  const key = CacheKeys.session.user(tokenHash);

  const cached = await cache.get<CachedUserData>(key);

  if (cached) {
    logger.debug("[SessionCache] Cache hit for user data", {
      tokenHash: tokenHash.substring(0, 8),
      userId: cached.user.id,
    });
    return cached.user;
  }

  return null;
}
