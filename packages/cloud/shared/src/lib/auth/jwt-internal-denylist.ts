/**
 * Internal JWT `jti` Revocation Denylist
 *
 * Backs the `jti` (JWT ID) revocation contract for internal service-to-service
 * tokens minted by {@link ./jwt-internal.signInternalToken}.
 *
 * ## Revocation model
 * Internal tokens are short-lived (1h, see `TOKEN_LIFETIME_SECONDS`). Two
 * complementary revocation mechanisms exist:
 *
 *  1. **Signing-key rotation** — rotating `JWT_SIGNING_*` invalidates *every*
 *     outstanding token immediately. This is the blast-radius control.
 *  2. **Per-`jti` denylist (this module)** — revokes a *single* compromised
 *     token before its natural expiry, without disrupting every other pod.
 *
 * The denylist is stored in the same Redis backend already used across cloud
 * (rate limits, credit events, A2A task store — see `cache/redis-factory`).
 * Entries are written with a TTL equal to the token's remaining lifetime, so
 * the store self-cleans and never grows unbounded: once a revoked token would
 * have expired anyway, its denylist entry expires too.
 *
 * ## Fail-closed
 * `isJtiRevoked` throws on a store error rather than returning `false`. The
 * verifier ({@link ./jwt-internal.verifyInternalToken}) treats a thrown
 * denylist check as a verification failure — a token is never accepted while
 * the denylist is unreachable. This matches the repo's no-silent-fallback
 * policy (never `catch → allow`).
 *
 * ## Degradation (no Redis configured)
 * When no Redis backend is configured at all, per-`jti` revocation is
 * genuinely unsupported and the honest contract is key-rotation + TTL. In that
 * case {@link isDenylistConfigured} returns `false`; the verifier documents and
 * enforces this by skipping the (impossible) denylist read instead of failing
 * every request. Deployments that require same-hour single-token revocation
 * MUST configure a runtime-compatible Redis backend: `REDIS_URL` on Node, or
 * `KV_REST_API_*` / `UPSTASH_REDIS_REST_*` in Cloudflare Workers.
 */

import {
  buildRedisClient,
  type CompatibleRedis,
  hasRedisConfig,
  isCloudflareWorkerRuntime,
  type RedisFactoryEnvSource,
} from "../cache/redis-factory";
import { logger } from "../utils/logger";

/** Redis key prefix for revoked internal-JWT ids. */
const DENYLIST_KEY_PREFIX = "internal-jwt:revoked:";

/**
 * Absolute ceiling (seconds) for a denylist entry's TTL. Guards against a
 * bogus/oversized `expSeconds` pinning a key in Redis indefinitely. No internal
 * token lives longer than `TOKEN_LIFETIME_SECONDS` (1h), so 2h is generous.
 */
const MAX_DENYLIST_TTL_SECONDS = 2 * 60 * 60;

/** Env prefix so dev/prod sharing one Redis instance don't collide. */
const ENV_PREFIX = process.env.ENVIRONMENT || "local";

function denylistKey(jti: string): string {
  return `${ENV_PREFIX}:${DENYLIST_KEY_PREFIX}${jti}`;
}

let cachedRedis: CompatibleRedis | null = null;

/**
 * Select only Redis transports that the current runtime can actually use.
 * Production Workers may inherit Railway's TCP `REDIS_URL`, but workerd cannot
 * reliably reach that external socket. Treating it as a usable revocation
 * store rejects every otherwise-valid internal token. REST Redis remains
 * available and fail-closed in Workers; Node keeps the normal TCP-first
 * factory resolution.
 */
function getDenylistRedisEnv(): RedisFactoryEnvSource {
  if (!isCloudflareWorkerRuntime()) return process.env;

  return {
    MOCK_REDIS: process.env.MOCK_REDIS,
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}

/**
 * Resolve the Redis client. On Workers a client is built per call (a cached TCP
 * socket belongs to the request that opened it); on Node the client is cached.
 * Mirrors the pattern in `middleware/rate-limit-redis`.
 */
function getRedis(): CompatibleRedis | null {
  if (!isCloudflareWorkerRuntime() && cachedRedis) return cachedRedis;
  const client = buildRedisClient(getDenylistRedisEnv());
  if (client && !isCloudflareWorkerRuntime()) cachedRedis = client;
  return client;
}

/**
 * True when a Redis backend is configured and per-`jti` revocation is therefore
 * supported. When `false`, revocation falls back to key-rotation + TTL only.
 */
export function isDenylistConfigured(): boolean {
  return hasRedisConfig(getDenylistRedisEnv());
}

/**
 * Clamp a token's remaining lifetime to a sane positive TTL for the denylist
 * entry. Already-expired tokens still get a small floor so a same-instant
 * revoke+verify race is honored.
 */
function computeTtlSeconds(expSeconds: number | undefined): number {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof expSeconds !== "number" || !Number.isFinite(expSeconds)) {
    // No/invalid exp — fall back to the max token lifetime ceiling.
    return MAX_DENYLIST_TTL_SECONDS;
  }
  const remaining = expSeconds - nowSeconds;
  if (remaining <= 0) return 1; // floor so a just-expired revoke is still recorded briefly
  return Math.min(remaining, MAX_DENYLIST_TTL_SECONDS);
}

/**
 * Revoke a single internal token by its `jti`. Idempotent.
 *
 * @param jti - the token id to revoke (from `payload.jti`).
 * @param expSeconds - the token's `exp` (Unix seconds). Used to auto-expire the
 *   denylist entry once the token would have expired anyway.
 * @throws if no Redis is configured (revocation is impossible — caller must
 *   know it did NOT take effect) or if the store write fails.
 */
export async function revokeInternalToken(jti: string, expSeconds?: number): Promise<void> {
  if (!jti) {
    throw new Error("revokeInternalToken: jti is required");
  }
  const redis = getRedis();
  if (!redis) {
    throw new Error(
      "revokeInternalToken: no Redis backend configured — per-jti revocation unsupported; rotate JWT_SIGNING_* keys instead",
    );
  }
  const ttl = computeTtlSeconds(expSeconds);
  // `set key value EX ttl` — value is a marker; presence is what matters.
  await redis.set(denylistKey(jti), "1", { ex: ttl });
  logger.info("[internal-jwt] revoked jti", { jti, ttl });
}

/**
 * Check whether a `jti` has been revoked.
 *
 * @returns `true` if revoked, `false` if not (or if the denylist is not
 *   configured — see module docs; that path is only reached when Redis is
 *   entirely absent, i.e. revocation is unsupported by deployment).
 * @throws if the store read fails while Redis IS configured — the caller must
 *   fail closed (reject the token) rather than treat an errored check as "not
 *   revoked".
 */
export async function isJtiRevoked(jti: string): Promise<boolean> {
  if (!jti) {
    // A missing jti can never have been individually revoked; the verifier
    // already rejects tokens without a jti claim upstream.
    return false;
  }
  const redis = getRedis();
  if (!redis) {
    // No backend configured: per-jti revocation genuinely unsupported.
    // Honest contract is key-rotation + TTL; do not fabricate a check result.
    return false;
  }
  // Intentionally NOT wrapped in try/catch → allow: a store error must
  // propagate so the verifier fails closed.
  const hit = await redis.get(denylistKey(jti));
  return hit !== null && hit !== undefined;
}

/** Test-only: drop the cached client so a fresh env is picked up. */
export function __resetDenylistClientForTests(): void {
  cachedRedis = null;
}
