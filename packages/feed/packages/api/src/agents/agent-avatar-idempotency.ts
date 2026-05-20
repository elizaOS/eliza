/**
 * Singleflight + short TTL cache for agent avatar generation.
 *
 * Same user + idempotency key → at most one fal/storage pipeline in flight,
 * and repeat requests within TTL return the stored URL without regenerating.
 */

import { createHash } from "node:crypto";
import { getCache, setCache } from "../cache/cache-service";

const CACHE_NAMESPACE = "agent_avatar_idem";
const TTL_SECONDS = 900;

const inflight = new Map<string, Promise<{ url: string }>>();

function cacheKeyFor(userId: string, idempotencyKey: string): string {
  const hash = createHash("sha256").update(idempotencyKey).digest("hex");
  return `${userId}:${hash}`;
}

/** Fast path for API: return stored URL without starting fal (skips rate limit). */
export async function getCachedAgentAvatarUrl(
  userId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const cacheKey = cacheKeyFor(userId, idempotencyKey);
  const cached = await getCache<{ url: string }>(cacheKey, {
    namespace: CACHE_NAMESPACE,
    ttl: TTL_SECONDS,
  });
  return cached?.url ?? null;
}

/**
 * Run `work` at most once per (userId, idempotencyKey) until TTL expires.
 */
export async function executeAgentAvatarOnce(
  userId: string,
  idempotencyKey: string,
  work: () => Promise<{ url: string }>,
): Promise<{ url: string }> {
  const cacheKey = cacheKeyFor(userId, idempotencyKey);

  const cached = await getCache<{ url: string }>(cacheKey, {
    namespace: CACHE_NAMESPACE,
    ttl: TTL_SECONDS,
  });
  if (cached?.url) {
    return { url: cached.url };
  }

  let pending = inflight.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const again = await getCache<{ url: string }>(cacheKey, {
        namespace: CACHE_NAMESPACE,
        ttl: TTL_SECONDS,
      });
      if (again?.url) {
        return { url: again.url };
      }
      const result = await work();
      await setCache(
        cacheKey,
        { url: result.url },
        {
          namespace: CACHE_NAMESPACE,
          ttl: TTL_SECONDS,
        },
      );
      return result;
    })().finally(() => {
      inflight.delete(cacheKey);
    });
    inflight.set(cacheKey, pending);
  }

  return pending;
}
