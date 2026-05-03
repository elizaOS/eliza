/**
 * Caching decorator for `ApiKeyRepository`.
 *
 * Owns the api-key validation cache exclusively — keys, TTLs, negative
 * caching, and invalidation on writes all live here. Other layers
 * (use cases, routes) never touch the cache directly.
 *
 * Wraps any inner `ApiKeyRepository` (typically a `PostgresApiKeyRepository`)
 * and adds:
 *   - Cache `findActiveByHash` with positive TTL + short negative TTL.
 *   - Invalidate the validation cache on `update`, `delete`, and
 *     `deactivateUserKeysByName` (the writes that change auth status).
 *   - Pass through reads that aren't worth caching (`findById`,
 *     `listByOrganization`, etc.).
 */

import type { Cache } from "@/lib/domain/cache/cache";
import type { ApiKey, NewApiKey } from "@/lib/domain/api-key/api-key";
import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";

const NEGATIVE_TTL_SECONDS = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * Defense-in-depth: validate that whatever we read from cache really looks
 * like an `ApiKey` row. A corrupted or stale-shape entry shouldn't poison
 * auth — drop it and re-read from the inner repository.
 */
function looksLikeApiKey(v: unknown): v is ApiKey {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  return (
    isUuid(c.id) &&
    isUuid(c.organization_id) &&
    isUuid(c.user_id) &&
    typeof c.key_hash === "string" &&
    typeof c.key_prefix === "string" &&
    typeof c.is_active === "boolean"
  );
}

function validationCacheKey(hash: string): string {
  return CacheKeys.apiKey.validation(hash.substring(0, 16));
}

export class CachedApiKeyRepository implements ApiKeyRepository {
  constructor(
    private readonly inner: ApiKeyRepository,
    private readonly cache: Cache,
  ) {}

  // ── Cached read (hot path) ───────────────────────────────────────────
  async findActiveByHash(hash: string): Promise<ApiKey | undefined> {
    const key = validationCacheKey(hash);
    const result = await this.cache.wrapNullable<ApiKey>(
      async () => (await this.inner.findActiveByHash(hash)) ?? null,
      {
        key,
        ttl: CacheTTL.apiKey.validation,
        negativeTtl: NEGATIVE_TTL_SECONDS,
      },
    );
    if (result === null) return undefined;
    if (!looksLikeApiKey(result)) {
      await this.cache.del(key);
      const fresh = await this.inner.findActiveByHash(hash);
      return fresh;
    }
    return result;
  }

  // ── Pass-through reads ───────────────────────────────────────────────
  findById(id: string): Promise<ApiKey | undefined> {
    return this.inner.findById(id);
  }

  findByHash(hash: string): Promise<ApiKey | undefined> {
    return this.inner.findByHash(hash);
  }

  listByOrganization(organizationId: string): Promise<ApiKey[]> {
    return this.inner.listByOrganization(organizationId);
  }

  findByUserAndName(userId: string, name: string): Promise<ApiKey[]> {
    return this.inner.findByUserAndName(userId, name);
  }

  // ── Writes — invalidate validation cache as needed ───────────────────
  create(data: NewApiKey): Promise<ApiKey> {
    // Newly-created keys aren't in the cache yet; nothing to invalidate.
    return this.inner.create(data);
  }

  async update(
    id: string,
    data: Partial<NewApiKey>,
  ): Promise<ApiKey | undefined> {
    const existing = await this.inner.findById(id);
    if (existing) {
      await this.cache.del(validationCacheKey(existing.key_hash));
    }
    return this.inner.update(id, data);
  }

  incrementUsage(id: string): Promise<void> {
    // usage_count + last_used_at don't affect validation result; skip invalidation.
    return this.inner.incrementUsage(id);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.inner.findById(id);
    if (existing) {
      await this.cache.del(validationCacheKey(existing.key_hash));
    }
    return this.inner.delete(id);
  }

  async deactivateUserKeysByName(userId: string, name: string): Promise<void> {
    const matched = await this.inner.findByUserAndName(userId, name);
    await Promise.all(
      matched.map((k) => this.cache.del(validationCacheKey(k.key_hash))),
    );
    return this.inner.deactivateUserKeysByName(userId, name);
  }

  // ── Explicit invalidation for callers writing through raw DB ─────────
  async invalidateValidationCache(keyHash: string): Promise<void> {
    await this.cache.del(validationCacheKey(keyHash));
  }
}
