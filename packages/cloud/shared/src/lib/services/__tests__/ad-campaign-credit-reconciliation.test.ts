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
  // Not synced to a platform -> no platform delete, no metrics refresh; the
  // stored total_spend is used directly. claimDelete gates the refund and the
  // refund is computed from that claimed row.
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

  test("#11151 mixed spend adds internal+external measures and clamps to allocation", async () => {
    // credits_spent 40 (allocated units) plus total_spend 100 USD -> 110
    // allocated-credit units; clamp at 110 leaves nothing to refund.
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
    track(spyOn(adCampaignsRepository, "claimDelete").mockResolvedValue(undefined as never));
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );
    const tx = track(spyOn(adTransactionsRepository, "create").mockResolvedValue({} as never));

    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

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
});

describe("updateCampaign — budget DECREASE refunds only unused + is atomic (#11292)", () => {
  beforeEach(() => {
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
    track(spyOn(advertisingService, "getProvider").mockReturnValue(stubProvider()));
  });

  test("decrease AFTER spend refunds only the UNUSED portion, not the full delta", async () => {
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
    expect(claim.mock.calls[0]?.[2]).toBe("110");
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

    expect(refund).toHaveBeenCalledTimes(1);
    expect((refund.mock.calls[0]?.[0] as { amount: number }).amount).toBeCloseTo(99, 9);
  });

  test("delete racing a decrease refunds from the CLAIMED row, keeping total refunds within the allocation", async () => {
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

    await advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, { budgetAmount: 10 });
    await advertisingService.deleteCampaign(CAMPAIGN_ID, ORG_ID);

    expect(refund).toHaveBeenCalledTimes(2);
    expect((refund.mock.calls[1]?.[0] as { amount: number }).amount).toBeCloseTo(11, 9);
    const totalRefunded = refund.mock.calls.reduce(
      (sum, call) => sum + (call[0] as { amount: number }).amount,
      0,
    );
    expect(totalRefunded).toBeLessThanOrEqual(110);
    expect(totalRefunded).toBeCloseTo(110, 9);
  });

  test("concurrent decrease: a LOST CAS throws and refunds nothing", async () => {
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
      spyOn(adCampaignsRepository, "claimAllocationChange").mockResolvedValue(undefined as never),
    );
    const refund = track(
      spyOn(creditsService, "refundCredits").mockResolvedValue({ success: true } as never),
    );

    await expect(
      advertisingService.updateCampaign(CAMPAIGN_ID, ORG_ID, { budgetAmount: 10 }),
    ).rejects.toThrow("changed concurrently");

    expect(refund).not.toHaveBeenCalled();
  });
});
