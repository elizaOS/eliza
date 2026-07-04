// Persists ad accounts records for cloud services through the shared DB boundary.
import { and, desc, eq, sql, sum } from "drizzle-orm";
import { db } from "../client";
import {
  type AdAccount,
  type AdAccountStatus,
  type AdPlatform,
  adAccounts,
  type NewAdAccount,
} from "../schemas/ad-accounts";
import { adCampaigns } from "../schemas/ad-campaigns";

export type { AdAccount, AdAccountStatus, AdPlatform, NewAdAccount };

export type AccountSpendCapUpdateResult =
  | { status: "updated"; account: AdAccount }
  | { status: "cap_exceeded"; allocated: number; cap: number }
  | { status: "not_found" };

/**
 * Repository for ad account database operations.
 */
export class AdAccountsRepository {
  async findById(id: string): Promise<AdAccount | undefined> {
    return await db.query.adAccounts.findFirst({
      where: eq(adAccounts.id, id),
    });
  }

  async findByExternalId(
    organizationId: string,
    platform: AdPlatform,
    externalAccountId: string,
  ): Promise<AdAccount | undefined> {
    return await db.query.adAccounts.findFirst({
      where: and(
        eq(adAccounts.organization_id, organizationId),
        eq(adAccounts.platform, platform),
        eq(adAccounts.external_account_id, externalAccountId),
      ),
    });
  }

  async listByOrganization(
    organizationId: string,
    options?: {
      platform?: AdPlatform;
      status?: AdAccountStatus;
      limit?: number;
      offset?: number;
    },
  ): Promise<AdAccount[]> {
    const conditions = [eq(adAccounts.organization_id, organizationId)];

    if (options?.platform) {
      conditions.push(eq(adAccounts.platform, options.platform));
    }

    if (options?.status) {
      conditions.push(eq(adAccounts.status, options.status));
    }

    return await db.query.adAccounts.findMany({
      where: and(...conditions),
      orderBy: desc(adAccounts.created_at),
      limit: options?.limit,
      offset: options?.offset,
    });
  }

  async create(data: NewAdAccount): Promise<AdAccount> {
    const [account] = await db.insert(adAccounts).values(data).returning();
    return account;
  }

  async update(id: string, data: Partial<NewAdAccount>): Promise<AdAccount | undefined> {
    const [updated] = await db
      .update(adAccounts)
      .set({ ...data, updated_at: new Date() })
      .where(eq(adAccounts.id, id))
      .returning();
    return updated;
  }

  async updateSpendCapWithAllocationCheck(
    id: string,
    organizationId: string,
    spendCapCredits: string | null,
  ): Promise<AccountSpendCapUpdateResult> {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`ad_account_spend_cap:${id}`}))`,
      );

      const [account] = await tx
        .select({ id: adAccounts.id })
        .from(adAccounts)
        .where(and(eq(adAccounts.id, id), eq(adAccounts.organization_id, organizationId)))
        .limit(1);
      if (!account) return { status: "not_found" };

      if (spendCapCredits) {
        const [result] = await tx
          .select({ total: sum(adCampaigns.credits_allocated) })
          .from(adCampaigns)
          .where(eq(adCampaigns.ad_account_id, id));
        const allocated = Number(result?.total ?? 0);
        const cap = Number(spendCapCredits);
        if (allocated > cap + 1e-9) {
          return { status: "cap_exceeded", allocated, cap };
        }
      }

      const [updated] = await tx
        .update(adAccounts)
        .set({ spend_cap_credits: spendCapCredits, updated_at: new Date() })
        .where(and(eq(adAccounts.id, id), eq(adAccounts.organization_id, organizationId)))
        .returning();
      if (!updated) return { status: "not_found" };
      return { status: "updated", account: updated };
    });
  }

  async updateStatus(id: string, status: AdAccountStatus): Promise<AdAccount | undefined> {
    return this.update(id, { status });
  }

  async delete(id: string): Promise<void> {
    await db.delete(adAccounts).where(eq(adAccounts.id, id));
  }
}

export const adAccountsRepository = new AdAccountsRepository();
