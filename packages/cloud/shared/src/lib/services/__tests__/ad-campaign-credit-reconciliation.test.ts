/**
 * Ad-campaign budget credit reconciliation on update + delete (#10265).
 *
 * createCampaign charges budget*markup up front (stored as credits_allocated).
 * Two money leaks were fixed:
 *
 *  - deleteCampaign refunded `credits_allocated - credits_spent`, but
 *    credits_spent is never written, so every delete refunded 100% of the
 *    prepaid budget + markup regardless of real ad spend ("free advertising").
 *    The fix refunds only the UNUSED fraction, derived from the real recorded
 *    spend (total_spend / budget_amount) scaled by credits_allocated.
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
  // Not synced to a platform → no platform delete, no metrics refresh; the
  // stored total_spend is used directly (the simplest path through the fix).
  // claimDelete gates the refund: only the caller that wins the atomic delete
  // gets the row back and refunds (#11292) — and the refund is computed from
  // that CLAIMED row, so stub claimDelete with the SAME row findById serves
  // (what DELETE ... RETURNING yields when nothing raced in between).
  function stubCampaignRow(over: Record<string, unknown> = {}) {
    const row = makeCampaign(over);
    track(spyOn(adCampaignsRepository, "findById").mockResolvedValue(row as never));
    track(spyOn(adCampaignsRepository, "claimDelete").mockResolvedValue(row as never));
  }

  test("budget 100 / allocated 110 / spent 40 → refunds 66, not the full 110", async () => {
    stubCampaignRow({ total_spend: "40" });
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
    stubCampaignRow({ total_spend: "100" });
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
    // external_campaign_id null (internal), total_spend "0", but 40 allocated
    // credits actually spent on served impressions.
    stubCampaignRow({ credits_spent: "40", total_spend: "0" });
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
    stubCampaignRow({ credits_spent: "110", total_spend: "0" });
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    expect(refund).not.toHaveBeenCalled();
  });

  test("#11151 mixed spend takes the MAX of internal+external measures (no double-refund)", async () => {
    // credits_spent 40 (allocated units) vs total_spend 100 USD → 100*1.1 = 110
    // allocated-credit units; the external measure dominates → nothing left.
    stubCampaignRow({ credits_spent: "40", total_spend: "100" });
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    expect(refund).not.toHaveBeenCalled();
  });

  test("#11292 concurrent delete: the loser (claimDelete returns nothing) refunds nothing", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ total_spend: "40" }) as never,
      ),
    );
    // This caller LOST the atomic delete race — claimDelete returns undefined.
    track(spyOn(adCampaignsRepository, "claimDelete").mockResolvedValue(undefined as never));
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    const tx = track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    // The winner already refunded the 66 unused; the loser must NOT double-refund.
    expect(refund).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });
});

describe("updateCampaign — reconciles the credit hold on a budget change", () => {
  beforeEach(() => {
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        id: "acct-1",
        organization_id: ORG_ID,
        platform: "meta",
        status: "active",
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

  test("#11800 budget INCREASE refunds and reverts provider if serialized account cap check loses a race", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1" }) as never,
      ),
    );
    track(spyOn(adCampaignsRepository, "sumCreditsAllocatedByAdAccount").mockResolvedValue(0));
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
    const provider = stubProvider();
    const providerUpdate = track(spyOn(provider, "updateCampaign"));
    track(spyOn(advertisingService, "getProvider").mockReturnValue(provider));
    track(
      spyOn(
        adCampaignsRepository,
        "claimAllocationChangeWithAccountSpendCapCheck",
      ).mockResolvedValue({
        status: "cap_exceeded",
        allocated: 220,
        cap: 150,
      }),
    );

    await expect(
      advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, {
        budgetAmount: 200,
      }),
    ).rejects.toThrow("Ad account spend cap would be exceeded");

    expect(deduct).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect((deduct.mock.calls[0]?.[0] as { amount: number }).amount).toBeCloseTo(110, 9);
    expect((refund.mock.calls[0]?.[0] as { amount: number }).amount).toBeCloseTo(110, 9);
    expect(providerUpdate).toHaveBeenCalledTimes(2);
    expect(providerUpdate.mock.calls[0]?.[2]).toMatchObject({ budgetAmount: 200 });
    expect(providerUpdate.mock.calls[1]?.[2]).toEqual({ budgetAmount: 100 });
  });

  test("#13415 budget INCREASE fails CLOSED, refunds + reverts provider on a corrupt account spend cap", async () => {
    // A corrupt 'NaN'::numeric spend cap makes the DB-repo enforcement return
    // cap_error (deny). Because the credit debit + provider budget increase have
    // ALREADY been applied at this point, updateCampaign must run the same
    // compensation as cap_exceeded (refund the delta + revert the provider) and
    // then fail, never bypass the cap and never leak credits or leave the
    // third-party campaign at the larger budget.
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1" }) as never,
      ),
    );
    track(spyOn(adCampaignsRepository, "sumCreditsAllocatedByAdAccount").mockResolvedValue(0));
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
    const provider = stubProvider();
    const providerUpdate = track(spyOn(provider, "updateCampaign"));
    track(spyOn(advertisingService, "getProvider").mockReturnValue(provider));
    track(
      spyOn(
        adCampaignsRepository,
        "claimAllocationChangeWithAccountSpendCapCheck",
      ).mockResolvedValue({
        status: "cap_error",
        reason: "Unable to read ad-account spend_cap_credits: value is not a valid NUMERIC",
      }),
    );

    await expect(
      advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, {
        budgetAmount: 200,
      }),
    ).rejects.toThrow("Ad account spend cap could not be verified");

    // Compensated: the increase was charged, then refunded, and the provider
    // budget was reverted to the original 100, net zero, no leak, cap not
    // bypassed.
    expect(deduct).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect((refund.mock.calls[0]?.[0] as { amount: number }).amount).toBeCloseTo(110, 9);
    expect(providerUpdate).toHaveBeenCalledTimes(2);
    expect(providerUpdate.mock.calls[1]?.[2]).toEqual({ budgetAmount: 100 });
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
});

describe("updateCampaign — budget DECREASE refunds only unused + is atomic (#11292)", () => {
  beforeEach(() => {
    track(
      spyOn(adAccountsRepository, "findById").mockResolvedValue({
        id: "acct-1",
        organization_id: ORG_ID,
        platform: "meta",
        status: "active",
      } as never),
    );
    track(
      spyOn(
        advertisingService as unknown as { getCredentials: () => Promise<unknown> },
        "getCredentials",
      ).mockResolvedValue({} as never),
    );
    track(spyOn(advertisingService, "getProvider").mockReturnValue(stubProvider()));
  });

  test("decrease AFTER spend refunds only the UNUSED portion, not the full delta", async () => {
    // budget 100 / allocated 110, external spend 80 USD → 88 allocated-credit
    // units spent (markup 1.1). Decrease to 10 (new allocated 11): freed = 99,
    // but only 110-88 = 22 is genuinely unused → refund 22, NOT 99 (the pre-fix
    // over-refund that returned credits already spent on real impressions).
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1" }) as never,
      ),
    );
    track(
      spyOn(advertisingService, "getCampaignMetrics").mockResolvedValue({
        spend: 80,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      } as never),
    );
    const claim = track(
      spyOn(adCampaignsRepository, "claimAllocationChange").mockResolvedValue(
        makeCampaign({
          external_campaign_id: "ext-1",
          budget_amount: "10",
          credits_allocated: "11",
        }) as never,
      ),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );

    await advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, { budgetAmount: 10 });

    expect(claim).toHaveBeenCalledTimes(1);
    // Atomic CAS keyed on the OBSERVED allocation ("110").
    expect(claim.mock.calls[0]?.[2]).toBe("110");
    // credits_allocated is written as newBudget*markup (11), NOT clamped to spend
    // — so the markup derived at delete (allocated/budget) stays correct.
    expect((claim.mock.calls[0]?.[3] as { credits_allocated?: string }).credits_allocated).toBe(
      "11",
    );
    expect(refund).toHaveBeenCalledTimes(1);
    expect((refund.mock.calls[0]?.[0] as { amount: number }).amount).toBeCloseTo(22, 9);
  });

  test("decrease with NO spend refunds the full freed amount", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1" }) as never,
      ),
    );
    track(
      spyOn(advertisingService, "getCampaignMetrics").mockResolvedValue({
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      } as never),
    );
    track(
      spyOn(adCampaignsRepository, "claimAllocationChange").mockResolvedValue(
        makeCampaign({
          external_campaign_id: "ext-1",
          budget_amount: "10",
          credits_allocated: "11",
        }) as never,
      ),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );

    await advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, { budgetAmount: 10 });

    // freed = 110 - 11 = 99, unused = 110 (nothing spent) → refund the full 99.
    expect(refund).toHaveBeenCalledTimes(1);
    expect((refund.mock.calls[0]?.[0] as { amount: number }).amount).toBeCloseTo(99, 9);
  });

  test("delete racing a decrease refunds from the CLAIMED row — total refunded never exceeds the allocation", async () => {
    // Cross-race: the delete reads its findById snapshot (allocated 110) BEFORE
    // a concurrent budget decrease (100 → 10) commits and refunds its freed 99.
    // Modeled at the repository seam: findById always serves the STALE 110-row,
    // while claimDelete hands the delete the row AS THE DECREASE LEFT IT
    // (allocated 11) — exactly what the atomic DELETE ... RETURNING sees.
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1" }) as never,
      ),
    );
    track(
      spyOn(advertisingService, "getCampaignMetrics").mockResolvedValue({
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      } as never),
    );
    const decreasedRow = makeCampaign({
      external_campaign_id: "ext-1",
      budget_amount: "10",
      credits_allocated: "11",
    });
    track(
      spyOn(adCampaignsRepository, "claimAllocationChange").mockResolvedValue(
        decreasedRow as never,
      ),
    );
    track(spyOn(adCampaignsRepository, "claimDelete").mockResolvedValue(decreasedRow as never));
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    // The decrease commits first and refunds its freed 110 - 11 = 99 …
    await advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, { budgetAmount: 10 });
    // … then the delete (holding the stale 110 snapshot) wins claimDelete.
    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    expect(refund).toHaveBeenCalledTimes(2);
    // The delete must refund only the still-allocated 11 from the claimed row —
    // pre-fix it refunded the snapshot's full 110 (209 total on 110 charged).
    expect((refund.mock.calls[1]?.[0] as { amount: number }).amount).toBeCloseTo(11, 9);
    const totalRefunded = refund.mock.calls.reduce(
      (sum, call) => sum + (call[0] as { amount: number }).amount,
      0,
    );
    expect(totalRefunded).toBeLessThanOrEqual(110);
    expect(totalRefunded).toBeCloseTo(110, 9);
  });

  test("concurrent decrease: a LOST CAS (claimAllocationChange returns nothing) throws and refunds nothing", async () => {
    track(
      spyOn(adCampaignsRepository, "findById").mockResolvedValue(
        makeCampaign({ external_campaign_id: "ext-1" }) as never,
      ),
    );
    track(
      spyOn(advertisingService, "getCampaignMetrics").mockResolvedValue({
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
      } as never),
    );
    // Another concurrent decrease already moved credits_allocated → CAS misses.
    track(
      spyOn(adCampaignsRepository, "claimAllocationChange").mockResolvedValue(undefined as never),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );

    await expect(
      advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, { budgetAmount: 10 }),
    ).rejects.toThrow("changed concurrently");

    // The winner refunded; the loser must NOT double-refund.
    expect(refund).not.toHaveBeenCalled();
  });
});
