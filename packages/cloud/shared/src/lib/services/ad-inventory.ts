/**
 * Ad Inventory / SSP service (#10687).
 *
 * Turns a miniapp into an ad publisher: manage ad slots, serve an eligible ad
 * into a slot, and earn from it. Serving is exactly-once (the impression event
 * gates the advertiser debit) and the publisher credit is idempotent on the
 * impression id. Reuses existing rails only — advertiser budget is the
 * pre-funded `ad_campaigns` credits, publisher payout is `redeemable_earnings`.
 */

import { adSlotsRepository } from "../../db/repositories/ad-slots";
import { appsRepository } from "../../db/repositories/apps";
import type { AdSlot, AdSlotFormat, AdSlotStatus } from "../../db/schemas/ad-slots";
import { logger } from "../utils/logger";
import { redeemableEarningsService } from "./redeemable-earnings";

/** Publisher share of the served price (rest is platform margin). */
function publisherShare(): number {
  const raw = process.env.ELIZA_AD_PUBLISHER_SHARE;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.7;
}

export interface ServedAd {
  impressionId: string;
  campaignId: string;
  creativeId: string;
  headline: string | null;
  primaryText: string | null;
  callToAction: string | null;
  destinationUrl: string | null;
  media: unknown;
  /** Publisher revenue attributed to this impression, in USD. */
  revenue: number;
}

export class AdInventoryService {
  createSlot(input: {
    appId: string;
    organizationId: string;
    name: string;
    format: AdSlotFormat;
    floorCpm: number;
  }): Promise<AdSlot> {
    return adSlotsRepository.create(input);
  }

  getSlot(id: string): Promise<AdSlot | undefined> {
    return adSlotsRepository.getById(id);
  }

  listSlots(organizationId: string): Promise<AdSlot[]> {
    return adSlotsRepository.listByOrg(organizationId);
  }

  updateSlot(
    id: string,
    patch: { name?: string; status?: AdSlotStatus; floorCpm?: number },
  ): Promise<AdSlot | undefined> {
    return adSlotsRepository.update(id, patch);
  }

  deleteSlot(id: string): Promise<void> {
    return adSlotsRepository.delete(id);
  }

  analytics(slotId: string) {
    return adSlotsRepository.analytics(slotId);
  }

  /**
   * Fill a slot with an eligible ad. Returns null when the slot is paused or no
   * eligible campaign exists. On success the advertiser is debited (exactly
   * once, gated by the impression event) and the publisher's redeemable
   * earnings are credited (idempotent on the impression id).
   */
  async serveAd(slot: AdSlot): Promise<ServedAd | null> {
    if (slot.status !== "active") return null;

    const eligible = await adSlotsRepository.findEligibleAd({
      publisherOrgId: slot.organization_id,
    });
    if (!eligible) return null;

    // CPM → per-impression price; publisher keeps its share.
    // NOTE: `ad_campaigns.credits_spent` is numeric(12,2) (cents), so a per-
    // impression debit below $0.01 rounds down — at CPMs under ~$10 the
    // advertiser is under-charged. Precise per-impression accounting (a scale-6
    // spend accumulator or batch aggregation) is a tracked follow-up; publisher
    // earnings are already scale-6 precise.
    const price = Number(slot.floor_cpm) / 1000;
    const revenue = Number((price * publisherShare()).toFixed(6));
    const impressionId = crypto.randomUUID();

    const event = await adSlotsRepository.recordServe({
      slotId: slot.id,
      campaignId: eligible.campaignId,
      creativeId: eligible.creativeId,
      impressionId,
      price,
      publisherRevenue: revenue,
    });
    if (!event) return null; // impression_id collision (astronomically unlikely)

    // Credit the publisher (the app's creator). Idempotent on the impression id;
    // best-effort — the impression + advertiser debit are already committed, so
    // a failure here is recoverable drift, never lost advertiser money.
    if (revenue > 0) {
      try {
        const app = await appsRepository.findById(slot.app_id);
        if (app?.created_by_user_id) {
          await redeemableEarningsService.addEarnings({
            userId: app.created_by_user_id,
            amount: revenue,
            source: "miniapp",
            sourceId: impressionId,
            dedupeBySourceId: true,
            description: `Ad revenue from slot ${slot.name}`,
            metadata: {
              kind: "ad_revenue",
              slotId: slot.id,
              appId: slot.app_id,
              campaignId: eligible.campaignId,
            },
          });
        }
      } catch (error) {
        logger.error("[AdInventory] failed to credit publisher ad revenue", {
          slotId: slot.id,
          impressionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      impressionId,
      campaignId: eligible.campaignId,
      creativeId: eligible.creativeId,
      headline: eligible.headline,
      primaryText: eligible.primaryText,
      callToAction: eligible.callToAction,
      destinationUrl: eligible.destinationUrl,
      media: eligible.media,
      revenue,
    };
  }

  /** Record a click on a served impression. Returns true if newly recorded. */
  async recordClick(slotId: string, impressionId: string): Promise<boolean> {
    const event = await adSlotsRepository.recordClick({ slotId, impressionId });
    return event !== null;
  }
}

export const adInventoryService = new AdInventoryService();
