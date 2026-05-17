import { and, count, desc, eq, sql, sum } from "drizzle-orm";
import { db } from "../client";
import { type AdPlatform } from "../schemas/ad-accounts";
import {
  type AdCampaign,
  adCampaigns,
  type BudgetType,
  type CampaignObjective,
  type CampaignStatus,
  type NewAdCampaign,
} from "../schemas/ad-campaigns";

export type { AdCampaign, BudgetType, CampaignObjective, CampaignStatus, NewAdCampaign };

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

  async delete(id: string): Promise<void> {
    await db.delete(adCampaigns).where(eq(adCampaigns.id, id));
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
