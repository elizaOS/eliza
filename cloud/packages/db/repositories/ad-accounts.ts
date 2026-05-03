import { and, desc, eq } from "drizzle-orm";
import { db } from "../client";
import {
  type AdAccount,
  type AdAccountStatus,
  type AdPlatform,
  adAccounts,
  type NewAdAccount,
} from "../schemas/ad-accounts";

export type { AdAccount, AdAccountStatus, AdPlatform, NewAdAccount };

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

  async updateStatus(id: string, status: AdAccountStatus): Promise<AdAccount | undefined> {
    return this.update(id, { status });
  }

  async delete(id: string): Promise<void> {
    await db.delete(adAccounts).where(eq(adAccounts.id, id));
  }
}

export const adAccountsRepository = new AdAccountsRepository();
