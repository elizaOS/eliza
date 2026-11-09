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

/** What the verified token contributed to a cached projection. */
export interface VerifiedSessionBinding {
  /** The token's `exp`, in seconds. */
  expiration: number;
  /** Fingerprint of the key that verified the token. */
  signingKeyFingerprint: string;
}

type CachedSessionUser = UserWithOrganization & { session_binding?: VerifiedSessionBinding };

/**
 * Seed the user projection only after the caller has verified the token and
 * durably committed the matching Cloud identity. This lets the first request
 * after a new signup avoid racing the waitUntil-owned provisioning tail. The
 * entry never outlives the token and is bound to the key that verified it.
 */
export async function primeVerifiedUserSessionCache(
  sessionToken: string,
  user: UserWithOrganization,
  binding: VerifiedSessionBinding,
): Promise<void> {
  const ttl = Math.min(CacheTTL.session.user, binding.expiration - Math.floor(Date.now() / 1000));
  if (ttl <= 0) return;
  const entry: CachedSessionUser = { ...user, session_binding: binding };
  await redisCache.set(CacheKeys.session.user(hashSessionToken(sessionToken)), entry, ttl);
}

/**
 * Read the projection primed for this token. A hit is served only while the
 * token is unexpired and the key that verified it is still the current one;
 * anything else is dropped so the caller verifies the token again.
 */
export async function readVerifiedUserSessionCache(
  sessionToken: string,
  currentKeyFingerprint: string | null,
): Promise<UserWithOrganization | null> {
  const cacheKey = CacheKeys.session.user(hashSessionToken(sessionToken));
  const cached = await redisCache.get<CachedSessionUser>(cacheKey);
  if (!cached) return null;
  const { session_binding: binding, ...user } = cached;
  if (
    !binding ||
    !currentKeyFingerprint ||
    binding.signingKeyFingerprint !== currentKeyFingerprint ||
    binding.expiration <= Math.floor(Date.now() / 1000)
  ) {
    await redisCache.del(cacheKey);
    return null;
  }
  return user;
}
