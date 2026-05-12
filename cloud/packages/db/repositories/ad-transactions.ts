import { and, desc, eq, sql, sum } from "drizzle-orm";
import { db } from "../client";
import {
  type AdTransaction,
  type AdTransactionType,
  adTransactions,
  type NewAdTransaction,
} from "../schemas/ad-transactions";

export type { AdTransaction, AdTransactionType, NewAdTransaction };

/**
 * Repository for ad transaction database operations.
 */
export class AdTransactionsRepository {
  async findById(id: string): Promise<AdTransaction | undefined> {
    return await db.query.adTransactions.findFirst({
      where: eq(adTransactions.id, id),
    });
  }

  async listByOrganization(
    organizationId: string,
    options?: {
      campaignId?: string;
      type?: AdTransactionType;
      limit?: number;
      offset?: number;
    },
  ): Promise<AdTransaction[]> {
    const conditions = [eq(adTransactions.organization_id, organizationId)];

    if (options?.campaignId) {
      conditions.push(eq(adTransactions.campaign_id, options.campaignId));
    }

    if (options?.type) {
      conditions.push(eq(adTransactions.type, options.type));
    }

    return await db.query.adTransactions.findMany({
      where: and(...conditions),
      orderBy: desc(adTransactions.created_at),
      limit: options?.limit,
      offset: options?.offset,
    });
  }

  async listByCampaign(
    campaignId: string,
    options?: { type?: AdTransactionType; limit?: number },
  ): Promise<AdTransaction[]> {
    const conditions = [eq(adTransactions.campaign_id, campaignId)];

    if (options?.type) {
      conditions.push(eq(adTransactions.type, options.type));
    }

    return await db.query.adTransactions.findMany({
      where: and(...conditions),
      orderBy: desc(adTransactions.created_at),
      limit: options?.limit,
    });
  }

  async create(data: NewAdTransaction): Promise<AdTransaction> {
    const [transaction] = await db.insert(adTransactions).values(data).returning();
    return transaction;
  }

  async getTotalSpendByOrganization(
    organizationId: string,
    options?: { startDate?: Date; endDate?: Date },
  ): Promise<{ totalAmount: number; totalCredits: number }> {
    const conditions = [
      eq(adTransactions.organization_id, organizationId),
      eq(adTransactions.type, "spend"),
    ];

    if (options?.startDate) {
      conditions.push(sql`${adTransactions.created_at} >= ${options.startDate}`);
    }

    if (options?.endDate) {
      conditions.push(sql`${adTransactions.created_at} <= ${options.endDate}`);
    }

    const [result] = await db
      .select({
        totalAmount: sum(adTransactions.amount),
        totalCredits: sum(adTransactions.credits_amount),
      })
      .from(adTransactions)
      .where(and(...conditions));

    return {
      totalAmount: Number(result?.totalAmount ?? 0),
      totalCredits: Number(result?.totalCredits ?? 0),
    };
  }

  async getTotalSpendByCampaign(campaignId: string): Promise<{
    totalAmount: number;
    totalCredits: number;
  }> {
    const [result] = await db
      .select({
        totalAmount: sum(adTransactions.amount),
        totalCredits: sum(adTransactions.credits_amount),
      })
      .from(adTransactions)
      .where(and(eq(adTransactions.campaign_id, campaignId), eq(adTransactions.type, "spend")));

    return {
      totalAmount: Number(result?.totalAmount ?? 0),
      totalCredits: Number(result?.totalCredits ?? 0),
    };
  }
}

export const adTransactionsRepository = new AdTransactionsRepository();
