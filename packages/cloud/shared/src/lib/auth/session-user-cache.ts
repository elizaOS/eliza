/**
 * Owns the Redis projection of a verified Steward session token to its Cloud
 * user. Callers must verify the token, commit identity, and finish all required
 * synchronous account readiness before priming this authorization-bearing
 * cache; this module never verifies tokens or provisions account resources.
 */

import { createHash } from "crypto";
import { cache as redisCache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import type { UserWithOrganization } from "../types";

/** One-way address used for every Redis entry owned by a Steward session token. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Seed the user projection only after the caller has verified the token and
 * durably committed the matching Cloud identity. This lets the first request
 * after a new signup avoid racing the waitUntil-owned provisioning tail.
 */
export async function primeVerifiedUserSessionCache(
  sessionToken: string,
  user: UserWithOrganization,
): Promise<void> {
  await redisCache.set(
    CacheKeys.session.user(hashSessionToken(sessionToken)),
    user,
    CacheTTL.session.user,
  );
}
