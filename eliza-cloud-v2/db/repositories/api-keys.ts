import { eq, and, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { apiKeys, type ApiKey, type NewApiKey } from "../schemas/api-keys";

export type { ApiKey, NewApiKey };

/**
 * Repository for API key database operations.
 *
 * Read operations → dbRead (read replica)
 * Write operations → dbWrite (NA primary)
 */
export class ApiKeysRepository {
  // ============================================================================
  // READ OPERATIONS (use read replica)
  // ============================================================================

  /**
   * Finds an API key by ID.
   */
  async findById(id: string): Promise<ApiKey | undefined> {
    return await dbRead.query.apiKeys.findFirst({
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
   * Lists all API keys for an organization.
   */
  async listByOrganization(organizationId: string): Promise<ApiKey[]> {
    return await dbRead.query.apiKeys.findMany({
      where: eq(apiKeys.organization_id, organizationId),
    });
  }

  // ============================================================================
  // WRITE OPERATIONS (use NA primary)
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
  async update(
    id: string,
    data: Partial<NewApiKey>,
  ): Promise<ApiKey | undefined> {
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
}

/**
 * Singleton instance of ApiKeysRepository.
 */
export const apiKeysRepository = new ApiKeysRepository();
