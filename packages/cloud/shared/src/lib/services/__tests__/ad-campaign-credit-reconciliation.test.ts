/**
 * Ad-campaign budget credit reconciliation on update + delete (#10265).
 *
 * createCampaign charges budget*markup up front (stored as credits_allocated).
 * Two money leaks were fixed:
 *
 *  - deleteCampaign refunded `credits_allocated - credits_spent`. The original
 *    #10265 reasoning ("credits_spent is never written") is STALE — it only
 *    checked incrementSpend's callers and missed recordServe's direct UPDATE, so
 *    internal SSP spend IS written to credits_spent. The fix refunds only the
 *    genuinely-UNUSED allocation, honoring BOTH spend streams — internal
 *    `credits_spent` AND external `total_spend` — SUMmed (they are disjoint,
 *    additive impression streams: findEligibleAd serves external campaigns too),
 *    and claims the row via an atomic DELETE...RETURNING so concurrent deletes
 *    can't double-refund (#11151/#11236).
 *
 *  - updateCampaign pushed a new budget LIVE to the ad platform but charged
 *    nothing for an increase and refunded nothing for a decrease. The fix
 *    charges the credit delta BEFORE pushing an increase live (fail-CLOSED on
 *    insufficient balance — never calls the platform), refunds the delta if the
 *    platform then rejects the increase, and refunds a decrease after the
 *    platform accepts it. A name-only change charges/refunds nothing.
 *
 * Tests the REAL advertisingService; only the repository, credentials, provider,
 * and creditsService boundaries are spied (no `mock.module`, so nothing leaks).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  adAccountsRepository,
  adCampaignsRepository,
  adTransactionsRepository,
} from "../../../db/repositories";
import { advertisingService } from "../advertising";
import type { AdProvider } from "../advertising/types";
import { creditsService } from "../credits";

const ORG_ID = "org-1";
const CAMPAIGN_ID = "campaign-1";

const spies: Array<{ mockRestore: () => void }> = [];
function track<T extends { mockRestore: () => void }>(s: T): T {
  spies.push(s);
  return s;
}

/** Base campaign row; override per test. credits_allocated = budget * 1.1. */
function makeCampaign(over: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID,
    organization_id: ORG_ID,
    ad_account_id: "acct-1",
    name: "My Campaign",
    external_campaign_id: null as string | null,
    budget_amount: "100",
    budget_currency: "USD",
    credits_allocated: "110",
    credits_spent: "0",
    total_spend: "0",
    total_impressions: 0,
    total_clicks: 0,
    total_conversions: 0,
    ...over,
  };
}

function stubProvider(over: Partial<AdProvider> = {}): AdProvider {
  return {
    platform: "meta",
    updateCampaign: async () => ({ success: true }),
    deleteCampaign: async () => ({ success: true }),
    ...over,
  } as unknown as AdProvider;
}

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

describe("deleteCampaign — refunds only the UNUSED budget fraction", () => {
  beforeEach(() => {
    // Not synced to a platform → no platform delete, no metrics refresh; the
    // stored total_spend is used directly (the simplest path through the fix).
    // deleteCampaign now CLAIMS the row via deleteReturning (#11236); delegate to
    // the per-test findById stub so the refund math sees the same row the winner
    // would get back from DELETE...RETURNING. (The concurrency describe below
    // overrides this to model a losing claim.)
    track(
      spyOn(adCampaignsRepository, "deleteReturning").mockImplementation((async (id: string) =>
        adCampaignsRepository.findById(id)) as never),
    );
  });

  test("budget 100 / allocated 110 / spent 40 → refunds 66, not the full 110", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ total_spend: "40" }) as never,
      ),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({
        success: true,
      } as never),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    expect(refund).toHaveBeenCalledTimes(1);
    const arg = refund.mock.calls[0]?.[0] as { amount: number };
    // 110 * (1 - 40/100) = 66 — NOT 110 (the old over-refund).
    expect(arg.amount).toBeCloseTo(66, 9);
  });

  test("fully-spent budget refunds nothing (no over-refund)", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ total_spend: "100" }) as never,
      ),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({
        success: true,
      } as never),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    // fractionSpent clamps to 1 → creditsRemaining 0 → no refund call.
    expect(refund).not.toHaveBeenCalled();
  });

  // #11151 — internal (miniapp) SSP campaigns accrue spend on `credits_spent`
  // (written by recordServe), NOT `total_spend` (only the external-provider sync
  // writes that). Before the fix, an internal campaign had total_spend "0" so
  // deleteCampaign refunded the FULL allocation after it spent real budget on
  // impressions. The refund must now honor credits_spent too.
  test("#11151 internal campaign spent via credits_spent → refunds only the unused portion, not the full allocation", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        // external_campaign_id null (internal), total_spend "0", but 40 allocated
        // credits actually spent on served impressions.
        makeCampaign({ credits_spent: "40", total_spend: "0" }) as never,
      ),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    expect(refund).toHaveBeenCalledTimes(1);
    const arg = refund.mock.calls[0]?.[0] as { amount: number };
    // credits_spent is already in allocated-credit units: 110 - 40 = 70.
    // Pre-fix this refunded the full 110 (free advertising).
    expect(arg.amount).toBeCloseTo(70, 9);
  });

  test("#11151 fully-spent internal campaign (credits_spent ≥ allocated) refunds nothing", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ credits_spent: "110", total_spend: "0" }) as never,
      ),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    expect(refund).not.toHaveBeenCalled();
  });

  test("#11236 dual-stream spend SUMs internal+external (was MAX) — combined spend exhausts allocation → no refund", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        // credits_spent 40 (allocated units) + total_spend 100 USD → 110
        // allocated-credit units. SUM = 150, clamped to allocated 110 → nothing
        // left. (MAX would have given the same here; the divergence case is the
        // next test.)
        makeCampaign({ credits_spent: "40", total_spend: "100" }) as never,
      ),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    expect(refund).not.toHaveBeenCalled();
  });

  test("#11236 dual-stream (internal + external) SUMs both — MAX would under-count and over-refund", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        // A campaign served on BOTH our SSP (credits_spent 30) and an external
        // provider (total_spend 20 USD → 22 allocated-credit units). Disjoint
        // impressions → additive. SUM = 52 spent, 110 - 52 = 58 unused.
        makeCampaign({
          external_campaign_id: "ext-1",
          credits_spent: "30",
          total_spend: "20",
        }) as never,
      ),
    );
    // external campaign → deleteCampaign refreshes spend; keep it at the stored 20.
    track(
      spyOn(advertisingService, "getCampaignMetrics").mockResolvedValue({
        spend: 20,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      } as never),
    );
    track(spyOn(advertisingService, "getProvider").mockReturnValue(stubProvider()));
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        id: "acct-1",
        organization_id: ORG_ID,
        platform: "meta",
      } as never),
    );
    track(
      spyOn(
        advertisingService as unknown as { getCredentials: () => Promise<unknown> },
        "getCredentials",
      ).mockResolvedValue({} as never),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    expect(refund).toHaveBeenCalledTimes(1);
    const arg = refund.mock.calls[0]?.[0] as { amount: number };
    // SUM: 110 - (30 + 20*1.1) = 58. A MAX(30, 22) would refund 80 — over-refunding
    // the 22 external credits the campaign actually spent.
    expect(arg.amount).toBeCloseTo(58, 6);
  });
});

describe("deleteCampaign — concurrency (#11236): the claim wins exactly once", () => {
  test("two concurrent deletes refund exactly ONCE (loser's DELETE...RETURNING is empty)", async () => {
    const campaign = makeCampaign({ total_spend: "40" });
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(campaign as never));
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    // Model the DB: DELETE ... RETURNING hands the row back exactly once (winner);
    // the loser's DELETE matches no row and returns undefined.
    let rowClaimed = false;
    track(
      spyOn(adCampaignsRepository, "deleteReturning").mockImplementation((async () => {
        if (rowClaimed) return undefined;
        rowClaimed = true;
        return campaign;
      }) as never),
    );

    await Promise.all([
      advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID),
      advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID),
    ]);

    // Pre-fix (findById snapshot → refund → non-transactional delete): both callers
    // saw creditsRemaining > 0 and BOTH refunded. Now exactly one claim wins.
    expect(refund).toHaveBeenCalledTimes(1);
  });
});

describe("updateCampaign — reconciles the credit hold on a budget change", () => {
  beforeEach(() => {
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        id: "acct-1",
        organization_id: ORG_ID,
        platform: "meta",
      } as never),
    );
    // getCredentials is private + hits the secrets vault; stub it out.
    track(
      spyOn(
        advertisingService as unknown as {
          getCredentials: () => Promise<unknown>;
        },
        "getCredentials",
      ).mockResolvedValue({} as never),
    );
  });

  test("budget INCREASE fails CLOSED on insufficient balance (platform never called)", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1" }) as never,
      ),
    );
    const deduct = track(
      spyOn(creditsService, "deductCredits").mockResolvedValue({
        success: false,
      } as never),
    );
    const provider = stubProvider();
    const providerUpdate = track(spyOn(provider, "updateCampaign"));
    track(spyOn(advertisingService, "getProvider").mockReturnValue(provider));

    await expect(
      // 100 → 200 budget: delta = 220 - 110 = 110 credits.
      advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, {
        budgetAmount: 200,
      }),
    ).rejects.toThrow("Insufficient credit balance for the budget increase");

    expect(deduct).toHaveBeenCalledTimes(1);
    expect((deduct.mock.calls[0]?.[0] as { amount: number }).amount).toBeCloseTo(110, 9);
    // Fail-closed: the increase is charged BEFORE the platform push, so the
    // platform must never have been called.
    expect(providerUpdate).not.toHaveBeenCalled();
  });

  test("budget INCREASE refunds the delta if the platform rejects it", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1" }) as never,
      ),
    );
    const deduct = track(
      spyOn(creditsService, "deductCredits").mockResolvedValue({
        success: true,
      } as never),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({
        success: true,
      } as never),
    );
    track(
      spyOn(advertisingService, "getProvider").mockReturnValue(
        stubProvider({
          updateCampaign: async () => ({
            success: false,
            error: "platform rejected",
          }),
        }),
      ),
    );

    await expect(
      advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, {
        budgetAmount: 200,
      }),
    ).rejects.toThrow("platform rejected");

    // Charged the increase, then refunded the SAME delta when the platform
    // rejected — net zero, no leak.
    expect(deduct).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect((deduct.mock.calls[0]?.[0] as { amount: number }).amount).toBeCloseTo(110, 9);
    expect((refund.mock.calls[0]?.[0] as { amount: number }).amount).toBeCloseTo(110, 9);
  });

  test("a name-only update charges and refunds nothing", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1" }) as never,
      ),
    );
    const deduct = track(
      spyOn(creditsService, "deductCredits").mockResolvedValue({
        success: true,
      } as never),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({
        success: true,
      } as never),
    );
    track(spyOn(advertisingService, "getProvider").mockReturnValue(stubProvider()));
    track(
      spyOn(adCampaignsRepository, "update").mockResolvedValue(
        makeCampaign({
          external_campaign_id: "ext-1",
          name: "Renamed",
        }) as never,
      ),
    );

    const updated = await advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, {
      name: "Renamed",
    });

    expect(updated.name).toBe("Renamed");
    // No budgetAmount in the input → no budget delta → no credit movement.
    expect(deduct).not.toHaveBeenCalled();
    expect(refund).not.toHaveBeenCalled();
  });

  test("#11236 budget DECREASE refunds only the UNUSED portion, clamped to spend (not the full delta)", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1", total_spend: "80" }) as never,
      ),
    );
    // Fresh external spend $80 → 88 allocated-credit units spent (markup 1.1),
    // leaving only 22 of the 110 allocated genuinely unused.
    track(
      spyOn(advertisingService, "getCampaignMetrics").mockResolvedValue({
        spend: 80,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      } as never),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    track(spyOn(advertisingService, "getProvider").mockReturnValue(stubProvider()));
    track(
      spyOn(adCampaignsRepository, "update").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1" }) as never,
      ),
    );

    // Decrease budget 100 → 10: the full credit delta is ~99, but only 22 are
    // genuinely unused, so the refund must clamp to 22.
    await advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, {
      budgetAmount: 10,
    });

    expect(refund).toHaveBeenCalledTimes(1);
    const arg = refund.mock.calls[0]?.[0] as { amount: number };
    // Pre-fix refunded the full ~99 delta — clawing back credits already spent
    // on real impressions. Clamped to the 22 genuinely-unused credits.
    expect(arg.amount).toBeCloseTo(22, 6);
  });
});
