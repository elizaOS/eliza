// Persists ad campaigns records for cloud services through the shared DB boundary.
import { and, count, desc, eq, ne, sql, sum } from "drizzle-orm";
import { db } from "../client";
import { type AdPlatform, adAccounts } from "../schemas/ad-accounts";
import {
  type AdCampaign,
  adCampaigns,
  type BudgetType,
  type CampaignObjective,
  type CampaignStatus,
  type NewAdCampaign,
} from "../schemas/ad-campaigns";

export type { AdCampaign, BudgetType, CampaignObjective, CampaignStatus, NewAdCampaign };

export type AccountSpendCapAllocationResult =
  | { status: "created"; campaign: AdCampaign }
  | { status: "updated"; campaign: AdCampaign }
  | { status: "cap_exceeded"; allocated: number; cap: number }
  | { status: "conflict" };

/**
 * Repository for ad campaign database operations.
 */
export class AdCampaignsRepository {
  async findById(id: string): Promise<AdCampaign | undefined> {
    return await db.query.adCampaigns.findFirst({
      where: eq(adCampaigns.id, id),
    });
  }

  async findByExternalId(externalCampaignId: string): Promise<AdCampaign | undefined> {
    return await db.query.adCampaigns.findFirst({
      where: eq(adCampaigns.external_campaign_id, externalCampaignId),
    });
  }

  async listByOrganization(
    organizationId: string,
    options?: {
      adAccountId?: string;
      platform?: AdPlatform;
      status?: CampaignStatus;
      appId?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<AdCampaign[]> {
    const conditions = [eq(adCampaigns.organization_id, organizationId)];

    if (options?.adAccountId) {
      conditions.push(eq(adCampaigns.ad_account_id, options.adAccountId));
    }

    if (options?.platform) {
      conditions.push(eq(adCampaigns.platform, options.platform));
    }

    if (options?.status) {
      conditions.push(eq(adCampaigns.status, options.status));
    }

    if (options?.appId) {
      conditions.push(eq(adCampaigns.app_id, options.appId));
    }

    return await db.query.adCampaigns.findMany({
      where: and(...conditions),
      orderBy: desc(adCampaigns.created_at),
      limit: options?.limit,
      offset: options?.offset,
    });
  }

  async listByAdAccount(adAccountId: string): Promise<AdCampaign[]> {
    return await db.query.adCampaigns.findMany({
      where: eq(adCampaigns.ad_account_id, adAccountId),
      orderBy: desc(adCampaigns.created_at),
    });
  }

  async create(data: NewAdCampaign): Promise<AdCampaign> {
    const [campaign] = await db.insert(adCampaigns).values(data).returning();
    return campaign;
  }

  async createWithAccountSpendCapCheck(
    data: NewAdCampaign,
    allocationCredits: number,
  ): Promise<AccountSpendCapAllocationResult> {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`ad_account_spend_cap:${data.ad_account_id}`}))`,
      );

      const [account] = await tx
        .select({ spendCapCredits: adAccounts.spend_cap_credits })
        .from(adAccounts)
        .where(
          and(
            eq(adAccounts.id, data.ad_account_id as string),
            eq(adAccounts.organization_id, data.organization_id as string),
          ),
        )
        .limit(1);
      if (!account) return { status: "conflict" };

      if (account.spendCapCredits) {
        const [result] = await tx
          .select({ total: sum(adCampaigns.credits_allocated) })
          .from(adCampaigns)
          .where(eq(adCampaigns.ad_account_id, data.ad_account_id as string));
        const allocated = Number(result?.total ?? 0) + allocationCredits;
        const cap = Number(account.spendCapCredits);
        if (allocated > cap + 1e-9) {
          return { status: "cap_exceeded", allocated, cap };
        }
      }

      const [campaign] = await tx.insert(adCampaigns).values(data).returning();
      return { status: "created", campaign };
    });
  }

  async update(id: string, data: Partial<NewAdCampaign>): Promise<AdCampaign | undefined> {
    const [updated] = await db
      .update(adCampaigns)
      .set({ ...data, updated_at: new Date() })
      .where(eq(adCampaigns.id, id))
      .returning();
    return updated;
  }

  async updateStatus(id: string, status: CampaignStatus): Promise<AdCampaign | undefined> {
    return this.update(id, { status });
  }

  async updateMetrics(
    id: string,
    metrics: {
      totalSpend?: string;
      totalImpressions?: number;
      totalClicks?: number;
      totalConversions?: number;
    },
  ): Promise<AdCampaign | undefined> {
    return this.update(id, {
      total_spend: metrics.totalSpend,
      total_impressions: metrics.totalImpressions,
      total_clicks: metrics.totalClicks,
      total_conversions: metrics.totalConversions,
    });
  }

  async incrementSpend(id: string, creditsSpent: string): Promise<AdCampaign | undefined> {
    const [updated] = await db
      .update(adCampaigns)
      .set({
        credits_spent: sql`${adCampaigns.credits_spent} + ${creditsSpent}::numeric`,
        updated_at: new Date(),
      })
      .where(eq(adCampaigns.id, id))
      .returning();
    return updated;
  }

  async sumCreditsAllocatedByAdAccount(
    adAccountId: string,
    options?: { excludeCampaignId?: string },
  ): Promise<number> {
    const conditions = [eq(adCampaigns.ad_account_id, adAccountId)];
    if (options?.excludeCampaignId) {
      conditions.push(ne(adCampaigns.id, options.excludeCampaignId));
    }
    const [result] = await db
      .select({ total: sum(adCampaigns.credits_allocated) })
      .from(adCampaigns)
      .where(and(...conditions));
    return Number(result?.total ?? 0);
  }

  async delete(id: string): Promise<void> {
    await db.delete(adCampaigns).where(eq(adCampaigns.id, id));
  }

  /**
   * Atomically apply an allocation-changing update ONLY if `credits_allocated`
   * still equals `expectedAllocated` (compare-and-swap). Returns the updated row
   * when this caller won the claim, or `undefined` when a concurrent budget
   * change already moved the allocation. Used to make a budget-decrease refund
   * single-winner so two concurrent decreases can't both refund (#11292).
   */
  async claimAllocationChange(
    id: string,
    organizationId: string,
    expectedAllocated: string,
    data: Partial<NewAdCampaign>,
  ): Promise<AdCampaign | undefined> {
    const [updated] = await db
      .update(adCampaigns)
      .set({ ...data, updated_at: new Date() })
      .where(
        and(
          eq(adCampaigns.id, id),
          eq(adCampaigns.organization_id, organizationId),
          eq(adCampaigns.credits_allocated, expectedAllocated),
        ),
      )
      .returning();
    return updated;
  }

  async claimAllocationChangeWithAccountSpendCapCheck(
    id: string,
    organizationId: string,
    adAccountId: string,
    expectedAllocated: string,
    newAllocatedCredits: number,
    data: Partial<NewAdCampaign>,
  ): Promise<AccountSpendCapAllocationResult> {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`ad_account_spend_cap:${adAccountId}`}))`,
      );

      const [account] = await tx
        .select({ spendCapCredits: adAccounts.spend_cap_credits })
        .from(adAccounts)
        .where(and(eq(adAccounts.id, adAccountId), eq(adAccounts.organization_id, organizationId)))
        .limit(1);
      if (!account) return { status: "conflict" };

      if (account.spendCapCredits) {
        const [result] = await tx
          .select({ total: sum(adCampaigns.credits_allocated) })
          .from(adCampaigns)
          .where(and(eq(adCampaigns.ad_account_id, adAccountId), ne(adCampaigns.id, id)));
        const allocated = Number(result?.total ?? 0) + newAllocatedCredits;
        const cap = Number(account.spendCapCredits);
        if (allocated > cap + 1e-9) {
          return { status: "cap_exceeded", allocated, cap };
        }
      }

      const [updated] = await tx
        .update(adCampaigns)
        .set({ ...data, updated_at: new Date() })
        .where(
          and(
            eq(adCampaigns.id, id),
            eq(adCampaigns.organization_id, organizationId),
            eq(adCampaigns.credits_allocated, expectedAllocated),
          ),
        )
        .returning();
      if (!updated) return { status: "conflict" };
      return { status: "updated", campaign: updated };
    });
  }

  /**
   * Atomically delete the campaign and return the deleted row — but only the
   * caller that actually removed the row gets it back; a concurrent second
   * delete (or a retry after a mid-op failure) gets `undefined`. Gates the
   * unused-budget refund so a delete can't double-refund (#11292).
   */
  async claimDelete(id: string, organizationId: string): Promise<AdCampaign | undefined> {
    const [deleted] = await db
      .delete(adCampaigns)
      .where(and(eq(adCampaigns.id, id), eq(adCampaigns.organization_id, organizationId)))
      .returning();
    return deleted;
  }

  async getStats(
    organizationId: string,
    options?: { adAccountId?: string; platform?: AdPlatform },
  ): Promise<{
    totalCampaigns: number;
    activeCampaigns: number;
    totalSpend: number;
    totalImpressions: number;
    totalClicks: number;
    totalConversions: number;
  }> {
    const conditions = [eq(adCampaigns.organization_id, organizationId)];

    if (options?.adAccountId) {
      conditions.push(eq(adCampaigns.ad_account_id, options.adAccountId));
    }

    if (options?.platform) {
      conditions.push(eq(adCampaigns.platform, options.platform));
    }

    const [result] = await db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${adCampaigns.status} = 'active')::int`,
        totalSpend: sum(adCampaigns.total_spend),
        totalImpressions: sum(adCampaigns.total_impressions),
        totalClicks: sum(adCampaigns.total_clicks),
        totalConversions: sum(adCampaigns.total_conversions),
      })
      .from(adCampaigns)
      .where(and(...conditions));

    return {
      totalCampaigns: result?.total ?? 0,
      activeCampaigns: result?.active ?? 0,
      totalSpend: Number(result?.totalSpend ?? 0),
      totalImpressions: Number(result?.totalImpressions ?? 0),
      totalClicks: Number(result?.totalClicks ?? 0),
      totalConversions: Number(result?.totalConversions ?? 0),
    };
  }
}

export const adCampaignsRepository = new AdCampaignsRepository();
