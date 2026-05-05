import { and, desc, eq } from "drizzle-orm";
import { db } from "../client";
import {
  type AdCreative,
  adCreatives,
  type CallToAction,
  type CreativeStatus,
  type CreativeType,
  type NewAdCreative,
} from "../schemas/ad-creatives";

export type { AdCreative, CallToAction, CreativeStatus, CreativeType, NewAdCreative };

/**
 * Repository for ad creative database operations.
 */
export class AdCreativesRepository {
  async findById(id: string): Promise<AdCreative | undefined> {
    return await db.query.adCreatives.findFirst({
      where: eq(adCreatives.id, id),
    });
  }

  async findByExternalId(externalCreativeId: string): Promise<AdCreative | undefined> {
    return await db.query.adCreatives.findFirst({
      where: eq(adCreatives.external_creative_id, externalCreativeId),
    });
  }

  async listByCampaign(
    campaignId: string,
    options?: {
      type?: CreativeType;
      status?: CreativeStatus;
      limit?: number;
      offset?: number;
    },
  ): Promise<AdCreative[]> {
    const conditions = [eq(adCreatives.campaign_id, campaignId)];

    if (options?.type) {
      conditions.push(eq(adCreatives.type, options.type));
    }

    if (options?.status) {
      conditions.push(eq(adCreatives.status, options.status));
    }

    return await db.query.adCreatives.findMany({
      where: and(...conditions),
      orderBy: desc(adCreatives.created_at),
      limit: options?.limit,
      offset: options?.offset,
    });
  }

  async create(data: NewAdCreative): Promise<AdCreative> {
    const [creative] = await db.insert(adCreatives).values(data).returning();
    return creative;
  }

  async update(id: string, data: Partial<NewAdCreative>): Promise<AdCreative | undefined> {
    const [updated] = await db
      .update(adCreatives)
      .set({ ...data, updated_at: new Date() })
      .where(eq(adCreatives.id, id))
      .returning();
    return updated;
  }

  async updateStatus(id: string, status: CreativeStatus): Promise<AdCreative | undefined> {
    return this.update(id, { status });
  }

  async delete(id: string): Promise<void> {
    await db.delete(adCreatives).where(eq(adCreatives.id, id));
  }

  async deleteByCampaign(campaignId: string): Promise<void> {
    await db.delete(adCreatives).where(eq(adCreatives.campaign_id, campaignId));
  }
}

export const adCreativesRepository = new AdCreativesRepository();
