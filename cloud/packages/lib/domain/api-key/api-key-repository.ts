/**
 * ApiKey repository contract — pure shape, no implementation.
 *
 * Two concrete implementations live in the infrastructure layer:
 *   - `PostgresApiKeyRepository` — delegates to `@/db/repositories` (no cache)
 *   - `CachedApiKeyRepository` — decorator wrapping any inner repository
 *
 * The composition root wires them together as
 * `new CachedApiKeyRepository(new PostgresApiKeyRepository(), cache)` and
 * passes the result to use cases.
 */

import type { ApiKey, NewApiKey } from "@/lib/domain/api-key/api-key";

export interface ApiKeyRepository {
  // ── Reads ────────────────────────────────────────────────────────────
  findById(id: string): Promise<ApiKey | undefined>;
  findByHash(hash: string): Promise<ApiKey | undefined>;
  /**
   * Find an active (non-expired, is_active=true) key by its hash. The Postgres
   * adapter handles consistency internally (replica-with-primary-fallback);
   * the cached decorator wraps the result with positive + negative caching.
   * Hot path — hit on every API-key-authenticated request.
   */
  findActiveByHash(hash: string): Promise<ApiKey | undefined>;
  listByOrganization(organizationId: string): Promise<ApiKey[]>;
  findByUserAndName(userId: string, name: string): Promise<ApiKey[]>;

  // ── Writes ───────────────────────────────────────────────────────────
  /** Persists the row. Caller (use case) is responsible for generating
   *  `key`, `key_hash`, and `key_prefix` before calling. */
  create(data: NewApiKey): Promise<ApiKey>;
  update(id: string, data: Partial<NewApiKey>): Promise<ApiKey | undefined>;
  incrementUsage(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  deactivateUserKeysByName(userId: string, name: string): Promise<void>;

  // ── Cache invalidation hook ──────────────────────────────────────────
  /**
   * Explicit invalidation point for callers that mutate via raw DB and need
   * to wipe the validation cache (e.g., admin tools writing directly).
   * On the cached implementation this calls `cache.del`; on the postgres
   * implementation this is a no-op.
   */
  invalidateValidationCache(keyHash: string): Promise<void>;
}
