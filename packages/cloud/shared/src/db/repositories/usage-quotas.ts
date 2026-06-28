import { and, eq, lte, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { type NewUsageQuota, type UsageQuota, usageQuotas } from "../schemas/usage-quotas";

export type { NewUsageQuota, UsageQuota };

/**
 * Repository for usage quota database operations.
 */
export class UsageQuotasRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a usage quota by ID.
   */
  async findById(id: string): Promise<UsageQuota | undefined> {
    return await dbRead.query.usageQuotas.findFirst({
      where: eq(usageQuotas.id, id),
    });
  }

  /**
   * Lists all usage quotas for an organization.
   */
  async findByOrganization(organizationId: string): Promise<UsageQuota[]> {
    return await dbRead.query.usageQuotas.findMany({
      where: eq(usageQuotas.organization_id, organizationId),
    });
  }

  /**
   * Lists active usage quotas for an organization.
   */
  async findActiveByOrganization(organizationId: string): Promise<UsageQuota[]> {
    return await dbRead.query.usageQuotas.findMany({
      where: and(eq(usageQuotas.organization_id, organizationId), eq(usageQuotas.is_active, true)),
    });
  }

  /**
   * Finds an active quota by organization, type, and optional model name.
   */
  async findByOrganizationAndType(
    organizationId: string,
    quotaType: string,
    modelName?: string | null,
  ): Promise<UsageQuota | undefined> {
    const conditions = [
      eq(usageQuotas.organization_id, organizationId),
      eq(usageQuotas.quota_type, quotaType),
      eq(usageQuotas.is_active, true),
    ];

    if (modelName) {
      conditions.push(eq(usageQuotas.model_name, modelName));
    } else {
      conditions.push(sql`${usageQuotas.model_name} IS NULL`);
    }

    return await dbRead.query.usageQuotas.findFirst({
      where: and(...conditions),
    });
  }

  /**
   * Checks if a quota has been exceeded.
   */
  async checkQuotaExceeded(id: string): Promise<boolean> {
    const quota = await this.findById(id);
    if (!quota) {
      return false;
    }

    const currentUsage = Number(quota.current_usage);
    const creditsLimit = Number(quota.credits_limit);

    return currentUsage >= creditsLimit;
  }

  /**
   * Lists all active quotas that have passed their period end date.
   */
  async listExpiredQuotas(): Promise<UsageQuota[]> {
    const now = new Date();
    return await dbRead.query.usageQuotas.findMany({
      where: and(eq(usageQuotas.is_active, true), lte(usageQuotas.period_end, now)),
    });
  }

  /**
   * Gets current usage breakdown for an organization.
   *
   * Returns global quota usage and model-specific quota usage.
   */
  async getCurrentUsage(organizationId: string): Promise<{
    global: { used: number; limit: number | null };
    modelSpecific: Record<string, { used: number; limit: number }>;
  }> {
    const quotas = await this.findActiveByOrganization(organizationId);

    const result = {
      global: { used: 0, limit: null as number | null },
      modelSpecific: {} as Record<string, { used: number; limit: number }>,
    };

    for (const quota of quotas) {
      if (quota.quota_type === "global") {
        result.global.used = Number(quota.current_usage);
        result.global.limit = Number(quota.credits_limit);
      } else if (quota.quota_type === "model_specific" && quota.model_name) {
        result.modelSpecific[quota.model_name] = {
          used: Number(quota.current_usage),
          limit: Number(quota.credits_limit),
        };
      }
    }

    return result;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new usage quota.
   */
  async create(data: NewUsageQuota): Promise<UsageQuota> {
    const [quota] = await dbWrite.insert(usageQuotas).values(data).returning();
    return quota;
  }

  /**
   * Updates an existing usage quota.
   */
  async update(id: string, data: Partial<NewUsageQuota>): Promise<UsageQuota | undefined> {
    const [updated] = await dbWrite
      .update(usageQuotas)
      .set({
        ...data,
        updated_at: new Date(),
      })
      .where(eq(usageQuotas.id, id))
      .returning();
    return updated;
  }

  /**
   * Resets usage count to zero for a quota.
   */
  async resetUsage(id: string): Promise<UsageQuota | undefined> {
    const [updated] = await dbWrite
      .update(usageQuotas)
      .set({
        current_usage: "0.00",
        updated_at: new Date(),
      })
      .where(eq(usageQuotas.id, id))
      .returning();
    return updated;
  }

  /**
   * Atomically increments usage count for a quota.
   */
  async incrementUsage(id: string, amount: number): Promise<UsageQuota | undefined> {
    const [updated] = await dbWrite
      .update(usageQuotas)
      .set({
        current_usage: sql`${usageQuotas.current_usage} + ${amount}`,
        updated_at: new Date(),
      })
      .where(eq(usageQuotas.id, id))
      .returning();
    return updated;
  }

  /**
   * Updates quota period and resets usage count to zero.
   */
  async updatePeriod(
    id: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<UsageQuota | undefined> {
    const [updated] = await dbWrite
      .update(usageQuotas)
      .set({
        period_start: periodStart,
        period_end: periodEnd,
        current_usage: "0.00",
        updated_at: new Date(),
      })
      .where(eq(usageQuotas.id, id))
      .returning();
    return updated;
  }

  /**
   * Deletes a usage quota by ID.
   */
  async delete(id: string): Promise<void> {
    await dbWrite.delete(usageQuotas).where(eq(usageQuotas.id, id));
  }
}

/**
 * Singleton instance of UsageQuotasRepository.
 */
export const usageQuotasRepository = new UsageQuotasRepository();
