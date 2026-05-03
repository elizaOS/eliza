/**
 * Policy definition cache backed by Redis.
 *
 * Caches policy definitions with a 30-second TTL to reduce DB queries
 * during high-throughput proxy operation.
 *
 * Key format: policies:{tenantId}:{agentId}
 */

import { getRedis } from "./client.js";

/** Default cache TTL in seconds */
const DEFAULT_TTL_SECONDS = 30;

/**
 * Minimal policy interface — matches what the policy engine needs.
 * Using a loose type here to avoid coupling to @stwd/shared versioning.
 */
export interface CachedPolicy {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  priority: number;
  definition: Record<string, unknown>;
  scope?: Record<string, unknown>;
}

function cacheKey(tenantId: string, agentId: string): string {
  return `policies:${tenantId}:${agentId}`;
}

/**
 * Get cached policies for an agent.
 *
 * @returns Cached policies array, or null if cache miss / expired.
 */
export async function getCachedPolicies(
  agentId: string,
  tenantId: string,
): Promise<CachedPolicy[] | null> {
  const redis = getRedis();
  const key = cacheKey(tenantId, agentId);

  const cached = await redis.get(key);
  if (!cached) return null;

  try {
    return JSON.parse(cached) as CachedPolicy[];
  } catch {
    // Corrupted cache entry — delete and return miss
    await redis.del(key);
    return null;
  }
}

/**
 * Cache policies for an agent.
 *
 * @param ttlSeconds - Cache TTL in seconds (default: 30)
 */
export async function setCachedPolicies(
  agentId: string,
  tenantId: string,
  policies: CachedPolicy[],
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const redis = getRedis();
  const key = cacheKey(tenantId, agentId);

  await redis.setex(key, ttlSeconds, JSON.stringify(policies));
}

/**
 * Invalidate cached policies for an agent.
 * Called on policy CRUD operations to ensure fresh data.
 */
export async function invalidateCache(agentId: string, tenantId?: string): Promise<void> {
  const redis = getRedis();

  if (tenantId) {
    // Invalidate specific agent's cache
    await redis.del(cacheKey(tenantId, agentId));
  } else {
    // Invalidate all caches for this agent (scan for matching keys)
    let cursor = "0";
    do {
      const [newCursor, keys] = await redis.scan(
        cursor,
        "MATCH",
        `policies:*:${agentId}`,
        "COUNT",
        100,
      );
      cursor = newCursor;
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } while (cursor !== "0");
  }
}

/**
 * Invalidate ALL policy caches for a tenant.
 * Useful when tenant-wide policies change.
 */
export async function invalidateTenantCache(tenantId: string): Promise<void> {
  const redis = getRedis();

  let cursor = "0";
  do {
    const [newCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `policies:${tenantId}:*`,
      "COUNT",
      100,
    );
    cursor = newCursor;
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } while (cursor !== "0");
}
