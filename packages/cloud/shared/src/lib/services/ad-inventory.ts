/**
 * Ad Inventory / SSP service (#10687).
 *
 * Turns a miniapp into an ad publisher: manage ad slots, serve an eligible ad
 * into a slot, and earn from it. Serving is exactly-once (the impression event
 * gates the advertiser debit, atomically bounded by the campaign's remaining
 * budget), the debit is floored to whole cents with sub-cent prices refused
 * (advertiser debit >= publisher payout, always), and the publisher credit is
 * settled from the pending impression row, idempotent on the impression id.
 * Reuses existing rails only — advertiser budget is the pre-funded
 * `ad_campaigns` credits, publisher payout is `redeemable_earnings`.
 */

import { adSlotsRepository, type EligibleAd } from "../../db/repositories/ad-slots";
import type { AdSlot, AdSlotFormat, AdSlotStatus } from "../../db/schemas/ad-slots";
import { logger } from "../utils/logger";
import { isWithinDayparting } from "./advertising/dayparting";
import { DaypartingScheduleSchema } from "./advertising/schemas";
import { redeemableEarningsService } from "./redeemable-earnings";

/** How many budget-ranked candidates to consider per serve before giving up. */
const ELIGIBLE_AD_CANDIDATES = 25;

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
   * True when the campaign may deliver right now: no dayparting means always;
   * otherwise the current instant must fall inside a window in the schedule's
   * own timezone. A schedule that fails validation (corrupt row — the write
   * path validates) fails CLOSED: the campaign is skipped, never billed.
   */
  private canDeliverNow(ad: EligibleAd, now: Date): boolean {
    if (!ad.dayparting) return true;
    const parsed = DaypartingScheduleSchema.safeParse(ad.dayparting);
    if (!parsed.success) {
      logger.warn("[AdInventory] campaign has an invalid dayparting schedule; skipping serve", {
        campaignId: ad.campaignId,
      });
      return false;
    }
    return isWithinDayparting(parsed.data, now);
  }

  /**
   * Fill a slot with an eligible ad. Returns null when the slot is paused, no
   * eligible campaign exists (or none may deliver in its dayparting window
   * right now), or the slot's per-impression price is below the minimum
   * billable unit. On success the advertiser is debited (exactly once, gated
   * by the impression event, atomically bounded by the campaign's remaining
   * budget) and the publisher's payout is settled from the pending impression
   * row (idempotent on the impression id).
   */
  async serveAd(slot: AdSlot): Promise<ServedAd | null> {
    if (slot.status !== "active") return null;

    const candidates = await adSlotsRepository.findEligibleAds({
      publisherOrgId: slot.organization_id,
      limit: ELIGIBLE_AD_CANDIDATES,
    });
    const now = new Date();
    const eligible = candidates.find((ad) => this.canDeliverNow(ad, now));
    if (!eligible) return null;

    // CPM → per-impression price, debited at the credits ledger's scale-2
    // (whole cents, rounded down). A price under one cent is REFUSED — debiting
    // $0.00 while paying the publisher a scale-6 share would mint money. A slot
    // is only billable at a floor CPM of at least $10.
    const priceCents = Math.floor(Math.round(Number(slot.floor_cpm) * 100) / 1000);
    if (priceCents < 1) {
      logger.warn("[AdInventory] floor CPM below minimum billable price; refusing serve", {
        slotId: slot.id,
        floorCpm: slot.floor_cpm,
      });
      return null;
    }
    const price = priceCents / 100;
    // Publisher share of the DEBITED amount (never of the raw price), clamped
    // to the debit at micro-USD, so advertiser debit >= publisher payout always.
    const revenue =
      Math.min(Math.round(priceCents * 10_000 * publisherShare()), priceCents * 10_000) / 1_000_000;
    const impressionId = crypto.randomUUID();

    const event = await adSlotsRepository.recordServe({
      slotId: slot.id,
      campaignId: eligible.campaignId,
      creativeId: eligible.creativeId,
      impressionId,
      price,
      publisherRevenue: revenue,
    });
    if (!event) return null; // budget exhausted, or impression_id replay

    // The impression row (committed with the advertiser debit) is the durable
    // pending-payout record; settle it — and any prior unsettled drift — now.
    await this.settlePendingPayouts();

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

  /**
   * Settle publisher payouts for impressions whose earnings credit has not
   * landed yet. Each unsettled impression row was written in the same
   * transaction as its advertiser debit, so it is the durable pending-payout
   * record: credit the publisher idempotently (deduped on the impression id by
   * the earnings ledger) and mark the row settled. Runs inline after every
   * serve, so a transient earnings failure is retried on the next serve — the
   * drift stays visible in the DB until it heals, never silent.
   */
  async settlePendingPayouts(limit = 25): Promise<{ settled: number; pending: number }> {
    const unsettled = await adSlotsRepository.findUnsettledPayouts(limit);
    let settled = 0;
    for (const payout of unsettled) {
      try {
        if (!payout.creatorUserId) {
          // Nobody to pay (app has no creator on record) — settle so the row
          // cannot strand the queue; the platform keeps the publisher share.
          logger.warn("[AdInventory] impression has no payable app creator; settling unpaid", {
            impressionId: payout.impressionId,
            slotId: payout.slotId,
            appId: payout.appId,
          });
          await adSlotsRepository.markPayoutSettled(payout.eventId);
          settled += 1;
          continue;
        }
        const result = await redeemableEarningsService.addEarnings({
          userId: payout.creatorUserId,
          amount: Number(payout.revenue),
          source: "miniapp",
          sourceId: payout.impressionId,
          dedupeBySourceId: true,
          description: `Ad revenue from slot ${payout.slotName}`,
          metadata: {
            kind: "ad_revenue",
            slotId: payout.slotId,
            appId: payout.appId,
            campaignId: payout.campaignId,
          },
        });
        if (!result.success) {
          logger.error("[AdInventory] publisher payout refused; will retry on next serve", {
            impressionId: payout.impressionId,
            slotId: payout.slotId,
            error: result.error,
          });
          continue;
        }
        await adSlotsRepository.markPayoutSettled(payout.eventId);
        settled += 1;
      } catch (error) {
        logger.error("[AdInventory] publisher payout failed; will retry on next serve", {
          impressionId: payout.impressionId,
          slotId: payout.slotId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { settled, pending: unsettled.length - settled };
  }
}

export const adInventoryService = new AdInventoryService();
