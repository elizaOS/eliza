// Persists ad conversions records for cloud services through the shared DB boundary.
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AdAttributionLink,
  type AdConversionEvent,
  type AdConversionEventType,
  adAttributionLinks,
  adConversionEvents,
  type NewAdAttributionLink,
  type NewAdConversionEvent,
} from "../schemas/ad-conversions";

export type {
  AdAttributionLink,
  AdConversionEvent,
  AdConversionEventType,
  NewAdAttributionLink,
  NewAdConversionEvent,
};

export interface ConversionRollup {
  conversions: number;
  value: number;
}

export class AdConversionsRepository {
  async findAttributionLink(input: {
    campaignId: string;
    creativeId?: string | null;
    destinationUrl: string;
    utmSource: string;
    utmMedium: string;
    utmCampaign: string;
    utmContent?: string | null;
    utmTerm?: string | null;
  }): Promise<AdAttributionLink | undefined> {
    return await dbRead.query.adAttributionLinks.findFirst({
      where: and(
        eq(adAttributionLinks.campaign_id, input.campaignId),
        input.creativeId
          ? eq(adAttributionLinks.creative_id, input.creativeId)
          : sql`${adAttributionLinks.creative_id} IS NULL`,
        eq(adAttributionLinks.destination_url, input.destinationUrl),
        eq(adAttributionLinks.utm_source, input.utmSource),
        eq(adAttributionLinks.utm_medium, input.utmMedium),
        eq(adAttributionLinks.utm_campaign, input.utmCampaign),
        input.utmContent
          ? eq(adAttributionLinks.utm_content, input.utmContent)
          : sql`${adAttributionLinks.utm_content} IS NULL`,
        input.utmTerm
          ? eq(adAttributionLinks.utm_term, input.utmTerm)
          : sql`${adAttributionLinks.utm_term} IS NULL`,
      ),
    });
  }

  async createAttributionLink(data: NewAdAttributionLink): Promise<AdAttributionLink> {
    const [link] = await dbWrite.insert(adAttributionLinks).values(data).returning();
    return link;
  }

  async recordConversion(data: NewAdConversionEvent): Promise<{
    event: AdConversionEvent;
    inserted: boolean;
  }> {
    const [inserted] = await dbWrite
      .insert(adConversionEvents)
      .values(data)
      .onConflictDoNothing({
        target: [
          adConversionEvents.campaign_id,
          adConversionEvents.event_type,
          adConversionEvents.dedupe_key,
        ],
      })
      .returning();

    if (inserted) {
      return { event: inserted, inserted: true };
    }

    const existing = await dbRead.query.adConversionEvents.findFirst({
      where: and(
        eq(adConversionEvents.campaign_id, data.campaign_id),
        eq(adConversionEvents.event_type, data.event_type),
        eq(adConversionEvents.dedupe_key, data.dedupe_key),
      ),
    });
    if (!existing) {
      throw new Error("Failed to load existing conversion event after dedupe conflict");
    }
    return { event: existing, inserted: false };
  }

  async getCampaignRollup(
    campaignId: string,
    dateRange?: { start: Date; end: Date },
  ): Promise<ConversionRollup> {
    const conditions = [eq(adConversionEvents.campaign_id, campaignId)];
    if (dateRange) {
      conditions.push(gte(adConversionEvents.occurred_at, dateRange.start));
      conditions.push(lte(adConversionEvents.occurred_at, dateRange.end));
    }

    const [row] = await dbRead
      .select({
        conversions: sql<number>`count(*)::int`,
        value: sql<string>`coalesce(sum(${adConversionEvents.value}), 0)`,
      })
      .from(adConversionEvents)
      .where(and(...conditions));

    return {
      conversions: row?.conversions ?? 0,
      value: Number(row?.value ?? 0),
    };
  }
}

export const adConversionsRepository = new AdConversionsRepository();
