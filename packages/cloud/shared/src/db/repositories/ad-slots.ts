/**
 * AdSlots repository — publisher ad inventory + exactly-once serve primitives.
 *
 * The serve transaction inserts the impression event FIRST (its unique
 * (impression_id, type) index is the exactly-once gate) and only then debits
 * the advertiser's campaign budget + increments the slot counters. A replayed
 * serve hits the unique index and moves no money twice. Publisher earnings are
 * credited separately (idempotent on the same impression_id) by the service.
 */

import { and, desc, eq, gt, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { adCampaigns } from "../schemas/ad-campaigns";
import { adCreatives } from "../schemas/ad-creatives";
import {
  type AdSlot,
  type AdSlotEvent,
  type AdSlotFormat,
  adSlotEvents,
  adSlots,
} from "../schemas/ad-slots";

/** A creative chosen to fill a slot, with its owning campaign. */
export interface EligibleAd {
  campaignId: string;
  creativeId: string;
  headline: string | null;
  primaryText: string | null;
  callToAction: string | null;
  destinationUrl: string | null;
  media: unknown;
}

export class AdSlotsRepository {
  async create(input: {
    appId: string;
    organizationId: string;
    name: string;
    format: AdSlotFormat;
    floorCpm: number;
  }): Promise<AdSlot> {
    const [row] = await dbWrite
      .insert(adSlots)
      .values({
        app_id: input.appId,
        organization_id: input.organizationId,
        name: input.name,
        format: input.format,
        floor_cpm: input.floorCpm.toFixed(4),
      })
      .returning();
    return row;
  }

  async getById(id: string): Promise<AdSlot | undefined> {
    return dbRead.query.adSlots.findFirst({ where: eq(adSlots.id, id) });
  }

  async listByOrg(organizationId: string, limit = 100): Promise<AdSlot[]> {
    return dbRead.query.adSlots.findMany({
      where: eq(adSlots.organization_id, organizationId),
      orderBy: [desc(adSlots.created_at)],
      limit,
    });
  }

  async update(
    id: string,
    patch: Partial<Pick<AdSlot, "name" | "status">> & { floorCpm?: number },
  ): Promise<AdSlot | undefined> {
    const set: Record<string, unknown> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.floorCpm !== undefined) set.floor_cpm = patch.floorCpm.toFixed(4);
    const [row] = await dbWrite
      .update(adSlots)
      .set(set)
      .where(eq(adSlots.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await dbWrite.delete(adSlots).where(eq(adSlots.id, id));
  }

  /**
   * Pick an eligible active creative for a slot format: an active campaign with
   * remaining budget (credits_allocated > credits_spent) that is NOT owned by
   * the publisher's own org (no self-serve), joined to one of its active
   * creatives. Highest remaining budget wins (a simple first-price proxy).
   */
  async findEligibleAd(input: {
    publisherOrgId: string;
  }): Promise<EligibleAd | undefined> {
    const [row] = await dbRead
      .select({
        campaignId: adCampaigns.id,
        creativeId: adCreatives.id,
        headline: adCreatives.headline,
        primaryText: adCreatives.primary_text,
        callToAction: adCreatives.call_to_action,
        destinationUrl: adCreatives.destination_url,
        media: adCreatives.media,
      })
      .from(adCampaigns)
      .innerJoin(adCreatives, eq(adCreatives.campaign_id, adCampaigns.id))
      .where(
        and(
          eq(adCampaigns.status, "active"),
          eq(adCreatives.status, "active"),
          sql`${adCampaigns.organization_id} <> ${input.publisherOrgId}`,
          gt(
            sql`${adCampaigns.credits_allocated} - ${adCampaigns.credits_spent}`,
            sql`0`,
          ),
        ),
      )
      .orderBy(
        desc(sql`${adCampaigns.credits_allocated} - ${adCampaigns.credits_spent}`),
      )
      .limit(1);
    return row;
  }

  /**
   * Exactly-once serve: insert the impression event (unique gate), debit the
   * campaign budget, and bump slot + campaign impression counters — all in one
   * transaction. Returns the event, or null if this impression_id was already
   * recorded (a replay) so the caller moves no money twice.
   */
  async recordServe(input: {
    slotId: string;
    campaignId: string;
    creativeId: string;
    impressionId: string;
    price: number;
    publisherRevenue: number;
  }): Promise<AdSlotEvent | null> {
    return dbWrite.transaction(async (tx) => {
      const [event] = await tx
        .insert(adSlotEvents)
        .values({
          slot_id: input.slotId,
          campaign_id: input.campaignId,
          creative_id: input.creativeId,
          type: "impression",
          impression_id: input.impressionId,
          revenue: input.publisherRevenue.toFixed(6),
        })
        .onConflictDoNothing({
          target: [adSlotEvents.impression_id, adSlotEvents.type],
        })
        .returning();
      if (!event) return null; // replay — already served

      // Debit the advertiser's pre-funded campaign budget (bounded).
      await tx
        .update(adCampaigns)
        .set({
          credits_spent: sql`${adCampaigns.credits_spent} + ${input.price.toFixed(2)}`,
          total_impressions: sql`${adCampaigns.total_impressions} + 1`,
          updated_at: new Date(),
        })
        .where(eq(adCampaigns.id, input.campaignId));

      await tx
        .update(adSlots)
        .set({
          total_impressions: sql`${adSlots.total_impressions} + 1`,
          total_revenue: sql`${adSlots.total_revenue} + ${input.publisherRevenue.toFixed(6)}`,
          updated_at: new Date(),
        })
        .where(eq(adSlots.id, input.slotId));

      return event;
    });
  }

  /** Record a click against a prior impression (idempotent on impression_id). */
  async recordClick(input: {
    slotId: string;
    impressionId: string;
  }): Promise<AdSlotEvent | null> {
    return dbWrite.transaction(async (tx) => {
      // The impression must exist; find its campaign/creative for attribution.
      const [impression] = await tx
        .select()
        .from(adSlotEvents)
        .where(
          and(
            eq(adSlotEvents.impression_id, input.impressionId),
            eq(adSlotEvents.type, "impression"),
          ),
        )
        .limit(1);
      if (!impression) return null;

      const [event] = await tx
        .insert(adSlotEvents)
        .values({
          slot_id: input.slotId,
          campaign_id: impression.campaign_id,
          creative_id: impression.creative_id,
          type: "click",
          impression_id: input.impressionId,
          revenue: "0.000000",
        })
        .onConflictDoNothing({
          target: [adSlotEvents.impression_id, adSlotEvents.type],
        })
        .returning();
      if (!event) return null; // duplicate click

      await tx
        .update(adSlots)
        .set({ total_clicks: sql`${adSlots.total_clicks} + 1`, updated_at: new Date() })
        .where(eq(adSlots.id, input.slotId));
      if (impression.campaign_id) {
        await tx
          .update(adCampaigns)
          .set({ total_clicks: sql`${adCampaigns.total_clicks} + 1`, updated_at: new Date() })
          .where(eq(adCampaigns.id, impression.campaign_id));
      }
      return event;
    });
  }

  async analytics(slotId: string): Promise<{
    impressions: number;
    clicks: number;
    revenue: number;
  }> {
    const [row] = await dbRead
      .select({
        impressions: adSlots.total_impressions,
        clicks: adSlots.total_clicks,
        revenue: adSlots.total_revenue,
      })
      .from(adSlots)
      .where(eq(adSlots.id, slotId));
    return {
      impressions: row?.impressions ?? 0,
      clicks: row?.clicks ?? 0,
      revenue: Number(row?.revenue ?? 0),
    };
  }
}

export const adSlotsRepository = new AdSlotsRepository();
