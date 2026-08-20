// Persists api keys records for cloud services through the shared DB boundary.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { dbRead, dbWrite } from "../helpers";
import { type ApiKey, apiKeys, type NewApiKey } from "../schemas/api-keys";

export type { ApiKey, NewApiKey };

/**
 * Repository for API key database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 *
 * The agent-provisioning writes (`create`, `deleteByName`) additionally accept
 * the caller's open `DbTransaction`. A caller that already holds a primary
 * connection MUST pass it: reaching for the global `dbWrite` pool from inside
 * an open transaction asks for a SECOND connection while the first is still
 * checked out. In the Cloudflare Worker runtime the pool is sized `max: 1`
 * (`db/client.ts` `createPgPool`), so that second checkout can never be
 * satisfied — the request deadlocks against itself and fails at
 * `connectionTimeoutMillis`, every time, with no concurrency involved.
 * Passing the transaction also makes the write part of the caller's atomic
 * unit rather than an independently committed side effect.
 */
export class ApiKeysRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds an API key by ID.
   */
  async findById(id: string): Promise<ApiKey | undefined> {
    return await dbRead.query.apiKeys.findFirst({
      where: eq(apiKeys.id, id),
    });
  }

  /** Finds an API key by ID on the primary connection for lifecycle mutations. */
  async findByIdConsistent(id: string): Promise<ApiKey | undefined> {
    return await dbWrite.query.apiKeys.findFirst({
      where: eq(apiKeys.id, id),
    });
  }

  /**
   * Finds an API key by its hash.
   */
  async findByHash(hash: string): Promise<ApiKey | undefined> {
    return await dbRead.query.apiKeys.findFirst({
      where: eq(apiKeys.key_hash, hash),
    });
  }

  /**
   * Finds an active, non-expired API key by hash.
   */
  async findActiveByHash(hash: string): Promise<ApiKey | undefined> {
    const apiKey = await dbRead.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.key_hash, hash),
        eq(apiKeys.is_active, true),
        isNull(apiKeys.deleted_at),
      ),
    });

    if (!apiKey) {
      return undefined;
    }

    // Check expiration
    if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
      return undefined;
    }

    return apiKey;
  }

  /**
   * Finds an active API key by hash on the primary connection.
   *
   * Credential validation uses this before caching a positive result. A
   * read-intent replica can lag either creation or revocation, while the
   * primary is the lifecycle authority for both transitions.
   */
  async findActiveByHashConsistent(hash: string): Promise<ApiKey | undefined> {
    const apiKey = await dbWrite.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.key_hash, hash),
        eq(apiKeys.is_active, true),
        isNull(apiKeys.deleted_at),
      ),
    });

    if (!apiKey) {
      return undefined;
    }

    if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
      return undefined;
    }

    return apiKey;
  }

  /**
   * Finds an active API key by id on the primary connection.
   *
   * Session credentials derived from an API key use this on every verify so a
   * delete, soft-delete, deactivation, or expiry takes effect without replica
   * lag or the normal API-key validation cache window.
   */
  async findActiveByIdConsistent(id: string, now: Date = new Date()): Promise<ApiKey | undefined> {
    const apiKey = await dbWrite.query.apiKeys.findFirst({
      where: and(eq(apiKeys.id, id), eq(apiKeys.is_active, true), isNull(apiKeys.deleted_at)),
    });

    if (!apiKey) return undefined;
    if (apiKey.expires_at && new Date(apiKey.expires_at) <= now) return undefined;
    return apiKey;
  }

  /**
   * Lists all API keys for an organization.
   */
  async listByOrganization(organizationId: string): Promise<ApiKey[]> {
    return await dbRead.query.apiKeys.findMany({
      where: eq(apiKeys.organization_id, organizationId),
    });
  }

  async findByUserAndName(userId: string, name: string): Promise<ApiKey[]> {
    return await dbRead.query.apiKeys.findMany({
      where: and(eq(apiKeys.user_id, userId), eq(apiKeys.name, name)),
    });
  }

  /** Lists active matching keys on the primary before a bulk lifecycle mutation. */
  async findActiveByUserAndNameConsistent(userId: string, name: string): Promise<ApiKey[]> {
    return await dbWrite.query.apiKeys.findMany({
      where: and(
        eq(apiKeys.user_id, userId),
        eq(apiKeys.name, name),
        eq(apiKeys.is_active, true),
        isNull(apiKeys.deleted_at),
      ),
    });
  }

  /**
   * Lists all API keys for a user. Used to fan-out inference auth-context cache
   * invalidation when a user is banned/deactivated (#9899) - the ban site only
   * knows the user_id, so it resolves the user's key hashes here.
   */
  async listByUser(userId: string): Promise<ApiKey[]> {
    return await dbRead.query.apiKeys.findMany({
      where: eq(apiKeys.user_id, userId),
    });
  }

  /** Lists active keys for one user and organization on the primary. */
  async listActiveByUserAndOrganizationConsistent(
    userId: string,
    organizationId: string,
  ): Promise<ApiKey[]> {
    return await dbWrite.query.apiKeys.findMany({
      where: and(
        eq(apiKeys.user_id, userId),
        eq(apiKeys.organization_id, organizationId),
        eq(apiKeys.is_active, true),
        isNull(apiKeys.deleted_at),
      ),
    });
  }

  async findByName(name: string): Promise<ApiKey[]> {
    return await dbRead.query.apiKeys.findMany({
      where: eq(apiKeys.name, name),
    });
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new API key. Runs on `tx` when the caller already holds a
   * primary connection.
   */
  async create(data: NewApiKey, tx?: DbTransaction): Promise<ApiKey> {
    const [apiKey] = await (tx ?? dbWrite).insert(apiKeys).values(data).returning();
    return apiKey;
  }

  /** Atomically replaces one immutable credential row with a freshly identified row. */
  async replace(id: string, replacement: NewApiKey): Promise<ApiKey> {
    return await dbWrite.transaction(async (tx) => {
      await tx.delete(apiKeys).where(eq(apiKeys.id, id));
      const [created] = await tx.insert(apiKeys).values(replacement).returning();
      return created;
    });
  }

  /**
   * Updates an existing API key.
   */
  async update(id: string, data: Partial<NewApiKey>): Promise<ApiKey | undefined> {
    const [updated] = await dbWrite
      .update(apiKeys)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(apiKeys.id, id))
      .returning();
    return updated;
  }

  /**
   * Atomically increments the usage count for an API key.
   *
   * Uses SQL atomic increment to prevent race conditions.
   */
  async incrementUsage(id: string): Promise<void> {
    await dbWrite
      .update(apiKeys)
      .set({
        usage_count: sql`${apiKeys.usage_count} + 1`,
        last_used_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(apiKeys.id, id));
  }

  /**
   * Deletes an API key by ID.
   */
  async delete(id: string): Promise<void> {
    await dbWrite.delete(apiKeys).where(eq(apiKeys.id, id));
  }

  async deactivateUserKeysByName(userId: string, name: string): Promise<void> {
    await dbWrite
      .update(apiKeys)
      .set({
        is_active: false,
        updated_at: new Date(),
      })
      .where(and(eq(apiKeys.user_id, userId), eq(apiKeys.name, name), eq(apiKeys.is_active, true)));
  }

  /**
   * Deletes every key carrying `name` and returns the removed rows. Runs on
   * `tx` when the caller already holds a primary connection.
   */
  async deleteByName(name: string, tx?: DbTransaction): Promise<ApiKey[]> {
    return await (tx ?? dbWrite).delete(apiKeys).where(eq(apiKeys.name, name)).returning();
  }

  /**
   * Deactivates every key carrying `name` — already-inactive rows included —
   * and returns them all. The agent-rotation revoke path uses this instead of
   * a DELETE so the row itself is the durable record of a hash whose cache
   * invalidation has not yet been confirmed: an inactive row cannot
   * authenticate from the database, and a later rotation re-collects it by
   * name and re-offers its hash for confirmed invalidation. Runs on `tx` when
   * the caller already holds a primary connection.
   */
  async deactivateByNameReturningAll(name: string, tx?: DbTransaction): Promise<ApiKey[]> {
    return await (tx ?? dbWrite)
      .update(apiKeys)
      .set({ is_active: false, updated_at: new Date() })
      .where(eq(apiKeys.name, name))
      .returning();
  }

  /**
   * Rows previously parked inactive by {@link deactivateByNameReturningAll}
   * whose cache invalidation was never confirmed. Read post-commit by the
   * launch boundaries so every attempt — including one that re-uses a
   * persisted key and never re-mints — rediscovers outstanding carriers.
   */
  async findInactiveByName(name: string): Promise<ApiKey[]> {
    return await dbRead.query.apiKeys.findMany({
      where: and(eq(apiKeys.name, name), eq(apiKeys.is_active, false)),
    });
  }

  /**
   * Hard-deletes parked carriers whose cache invalidation has since been
   * CONFIRMED — and ONLY those. Scoping by exact hash (not just name) matters
   * under overlapping rotations: the lifecycle advisory lock releases at
   * COMMIT, so one attempt's delayed purge must never reap a carrier a newer
   * attempt has parked but not yet confirmed. `is_active = false` in the
   * predicate keeps an active replacement key untouchable even on collision.
   */
  async deleteInactiveByHashes(
    name: string,
    keyHashes: readonly string[],
    tx?: DbTransaction,
  ): Promise<number> {
    if (keyHashes.length === 0) return 0;
    const deleted = await (tx ?? dbWrite)
      .delete(apiKeys)
      .where(
        and(
          eq(apiKeys.name, name),
          eq(apiKeys.is_active, false),
          inArray(apiKeys.key_hash, [...keyHashes]),
        ),
      )
      .returning({ id: apiKeys.id });
    return deleted.length;
  }

  /**
   * Deactivates every active key a user holds in one organization. Used when a
   * member is detached from an org (#11332): their keys authenticate AS that
   * org (billing + access), and the plaintext is encrypted under the org's
   * DEK, so the keys can be neither kept nor re-scoped — they are revoked.
   */
  async deactivateByUserAndOrganization(userId: string, organizationId: string): Promise<void> {
    await dbWrite
      .update(apiKeys)
      .set({
        is_active: false,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(apiKeys.user_id, userId),
          eq(apiKeys.organization_id, organizationId),
          eq(apiKeys.is_active, true),
        ),
      );
  }
}

/**
 * Singleton instance of ApiKeysRepository.
 */
export const apiKeysRepository = new ApiKeysRepository();
