/**
 * Postgres adapter for `ApiKeyRepository`.
 *
 * Pure delegation to the existing `apiKeysRepository` singleton in
 * `@/db/repositories` — no caching, no business logic. Caching is composed
 * via `CachedApiKeyRepository` in the composition root.
 *
 * The adapter exists so the application layer depends on the
 * `ApiKeyRepository` interface from the domain, not on the Drizzle-flavored
 * `apiKeysRepository` directly.
 */

import { apiKeysRepository } from "@/db/repositories";
import type { ApiKey, NewApiKey } from "@/lib/domain/api-key/api-key";
import type { ApiKeyRepository } from "@/lib/domain/api-key/api-key-repository";

export class PostgresApiKeyRepository implements ApiKeyRepository {
  // ── Reads ────────────────────────────────────────────────────────────
  findById(id: string): Promise<ApiKey | undefined> {
    return apiKeysRepository.findById(id);
  }

  findByHash(hash: string): Promise<ApiKey | undefined> {
    return apiKeysRepository.findByHash(hash);
  }

  /**
   * Replica-first with primary fallback. The replica is eventually consistent
   * with NA primary (~ms lag); a freshly-issued key may not be visible on the
   * replica yet. We promote to primary on replica miss to absorb that window.
   */
  async findActiveByHash(hash: string): Promise<ApiKey | undefined> {
    const replica = await apiKeysRepository.findActiveByHash(hash);
    if (replica) return replica;
    return apiKeysRepository.findActiveByHashConsistent(hash);
  }

  listByOrganization(organizationId: string): Promise<ApiKey[]> {
    return apiKeysRepository.listByOrganization(organizationId);
  }

  findByUserAndName(userId: string, name: string): Promise<ApiKey[]> {
    return apiKeysRepository.findByUserAndName(userId, name);
  }

  // ── Writes ───────────────────────────────────────────────────────────
  create(data: NewApiKey): Promise<ApiKey> {
    return apiKeysRepository.create(data);
  }

  update(id: string, data: Partial<NewApiKey>): Promise<ApiKey | undefined> {
    return apiKeysRepository.update(id, data);
  }

  incrementUsage(id: string): Promise<void> {
    return apiKeysRepository.incrementUsage(id);
  }

  delete(id: string): Promise<void> {
    return apiKeysRepository.delete(id);
  }

  deactivateUserKeysByName(userId: string, name: string): Promise<void> {
    return apiKeysRepository.deactivateUserKeysByName(userId, name);
  }

  // No-op — caching lives in `CachedApiKeyRepository`. This adapter has no
  // cache to invalidate; the composition root always wraps it in the cached
  // decorator, which overrides this method.
  async invalidateValidationCache(_keyHash: string): Promise<void> {
    // intentionally empty
  }
}
