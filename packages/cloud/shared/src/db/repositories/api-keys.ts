// Persists api keys records for cloud services through the shared DB boundary.
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { type ApiKey, apiKeys, type NewApiKey } from "../schemas/api-keys";

export type { ApiKey, NewApiKey };

const MOBILE_RECOVERY_LIST_LIMIT = 100;

/**
 * Repository for API key database operations.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
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

  /** Reads one row from the primary for mutation authorization. */
  async findByIdConsistent(id: string): Promise<ApiKey | undefined> {
    return await dbWrite.query.apiKeys.findFirst({
      where: eq(apiKeys.id, id),
    });
  }

  /** Generic key-management surfaces never expose mobile lifecycle credentials. */
  async findManageableById(id: string): Promise<ApiKey | undefined> {
    return await dbRead.query.apiKeys.findFirst({
      where: and(eq(apiKeys.id, id), isNull(apiKeys.source_app_id)),
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

  /** Reads any matching row from the primary, including inactive mobile credentials. */
  async findByHashConsistent(hash: string): Promise<ApiKey | undefined> {
    return await dbWrite.query.apiKeys.findFirst({
      where: eq(apiKeys.key_hash, hash),
    });
  }

  /**
   * Finds an active, non-expired API key by hash.
   */
  async findActiveByHash(hash: string): Promise<ApiKey | undefined> {
    const apiKey = await dbRead.query.apiKeys.findFirst({
      where: and(eq(apiKeys.key_hash, hash), eq(apiKeys.is_active, true)),
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
   * Use this only to confirm a read-intent miss before negative-caching auth.
   * Newly-created keys must not be rejected just because a prior read path
   * returned stale data.
   */
  async findActiveByHashConsistent(hash: string): Promise<ApiKey | undefined> {
    const apiKey = await dbWrite.query.apiKeys.findFirst({
      where: and(eq(apiKeys.key_hash, hash), eq(apiKeys.is_active, true)),
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
   * Lists all API keys for an organization.
   */
  async listByOrganization(organizationId: string): Promise<ApiKey[]> {
    return await dbRead.query.apiKeys.findMany({
      where: and(
        eq(apiKeys.organization_id, organizationId),
        isNull(apiKeys.deleted_at),
        isNull(apiKeys.source_app_id),
      ),
    });
  }

  async findByUserAndName(userId: string, name: string): Promise<ApiKey[]> {
    return await dbRead.query.apiKeys.findMany({
      where: and(eq(apiKeys.user_id, userId), eq(apiKeys.name, name)),
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

  async findByName(name: string): Promise<ApiKey[]> {
    return await dbRead.query.apiKeys.findMany({
      where: eq(apiKeys.name, name),
    });
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new API key.
   */
  async create(data: NewApiKey): Promise<ApiKey> {
    const [apiKey] = await dbWrite.insert(apiKeys).values(data).returning();
    return apiKey;
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
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.source_app_id)))
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
    await dbWrite.delete(apiKeys).where(and(eq(apiKeys.id, id), isNull(apiKeys.source_app_id)));
  }

  async findExactActiveMobileConsistent(id: string, keyHash: string): Promise<ApiKey | undefined> {
    return await dbWrite.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.id, id),
        eq(apiKeys.key_hash, keyHash),
        eq(apiKeys.is_active, true),
        isNull(apiKeys.deleted_at),
        isNotNull(apiKeys.source_app_id),
      ),
    });
  }

  /** Lists mobile lifecycle credentials from primary storage for account recovery. */
  async listMobileByOwnerConsistent(userId: string, organizationId: string): Promise<ApiKey[]> {
    return await dbWrite.query.apiKeys.findMany({
      where: and(
        eq(apiKeys.user_id, userId),
        eq(apiKeys.organization_id, organizationId),
        isNotNull(apiKeys.source_app_id),
      ),
      orderBy: [desc(apiKeys.created_at)],
      limit: MOBILE_RECOVERY_LIST_LIMIT,
    });
  }

  /** Resolves one mobile credential without revealing whether another owner has it. */
  async findMobileByOwnerConsistent(
    id: string,
    userId: string,
    organizationId: string,
  ): Promise<ApiKey | undefined> {
    return await dbWrite.query.apiKeys.findFirst({
      where: and(
        eq(apiKeys.id, id),
        eq(apiKeys.user_id, userId),
        eq(apiKeys.organization_id, organizationId),
        isNotNull(apiKeys.source_app_id),
      ),
    });
  }

  /** Tombstones an account-owned mobile credential and erases recoverable secret bytes. */
  async tombstoneMobileByOwner(
    id: string,
    userId: string,
    organizationId: string,
    revokedAt: Date,
  ): Promise<ApiKey | undefined> {
    const [tombstone] = await dbWrite
      .update(apiKeys)
      .set({
        is_active: false,
        deleted_at: revokedAt,
        updated_at: revokedAt,
        key_ciphertext: null,
        key_nonce: null,
        key_auth_tag: null,
        key_kms_key_id: null,
        key_kms_key_version: null,
      })
      .where(
        and(
          eq(apiKeys.id, id),
          eq(apiKeys.user_id, userId),
          eq(apiKeys.organization_id, organizationId),
          isNull(apiKeys.deleted_at),
          isNotNull(apiKeys.source_app_id),
        ),
      )
      .returning();
    return tombstone;
  }

  /** Retains only the hash-backed receipt and removes recoverable secret bytes. */
  async tombstoneExactMobileCredential(
    id: string,
    keyHash: string,
    revokedAt: Date,
  ): Promise<ApiKey | undefined> {
    const [tombstone] = await dbWrite
      .update(apiKeys)
      .set({
        is_active: false,
        deleted_at: revokedAt,
        updated_at: revokedAt,
        key_ciphertext: null,
        key_nonce: null,
        key_auth_tag: null,
        key_kms_key_id: null,
        key_kms_key_version: null,
      })
      .where(
        and(
          eq(apiKeys.id, id),
          eq(apiKeys.key_hash, keyHash),
          isNull(apiKeys.deleted_at),
          isNotNull(apiKeys.source_app_id),
        ),
      )
      .returning();
    return tombstone;
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

  async deleteByName(name: string): Promise<ApiKey[]> {
    return await dbWrite.delete(apiKeys).where(eq(apiKeys.name, name)).returning();
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
