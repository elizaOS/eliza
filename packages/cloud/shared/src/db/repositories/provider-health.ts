import { desc, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewProviderHealth,
  type ProviderHealth,
  providerHealth,
} from "../schemas/provider-health";

export type { NewProviderHealth, ProviderHealth };

/**
 * Repository for provider health monitoring database operations.
 */
export class ProviderHealthRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Lists all provider health records, ordered by last checked time.
   */
  async listAll(): Promise<ProviderHealth[]> {
    return await dbRead.query.providerHealth.findMany({
      orderBy: desc(providerHealth.last_checked),
    });
  }

  /**
   * Finds provider health record by provider name.
   */
  async findByProvider(provider: string): Promise<ProviderHealth | undefined> {
    return await dbRead.query.providerHealth.findFirst({
      where: eq(providerHealth.provider, provider),
    });
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates or updates a provider health record.
   *
   * Updates existing record if found, otherwise creates a new one.
   */
  async createOrUpdate(data: NewProviderHealth): Promise<ProviderHealth> {
    const existing = await this.findByProvider(data.provider);

    if (existing) {
      const [updated] = await dbWrite
        .update(providerHealth)
        .set({
          ...data,
          updated_at: new Date(),
        })
        .where(eq(providerHealth.provider, data.provider))
        .returning();
      return updated;
    }

    const [created] = await dbWrite.insert(providerHealth).values(data).returning();
    return created;
  }

  /**
   * Updates provider health status and metrics.
   */
  async updateStatus(
    provider: string,
    status: string,
    responseTime?: number,
    errorRate?: number,
  ): Promise<ProviderHealth | undefined> {
    const [updated] = await dbWrite
      .update(providerHealth)
      .set({
        status,
        response_time: responseTime,
        error_rate: errorRate ? errorRate.toString() : undefined,
        last_checked: new Date(),
        updated_at: new Date(),
      })
      .where(eq(providerHealth.provider, provider))
      .returning();
    return updated;
  }
}

/**
 * Singleton instance of ProviderHealthRepository.
 */
export const providerHealthRepository = new ProviderHealthRepository();
