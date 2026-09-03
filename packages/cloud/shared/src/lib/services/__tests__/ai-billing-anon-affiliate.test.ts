/**
 * Guard test for #10853 — anonymous free-tier chat must NOT mint affiliate
 * earnings.
 *
 * billUsage applied the affiliate markup + credited the affiliate owner
 * (redeemableEarningsService.addEarnings, cashable) whenever an active
 * affiliateCode was present — with no check that the request was actually
 * billed. On the anonymous free-tier path (organizationId "anonymous", a no-op
 * reservation) the user pays $0, so an org owner could farm their own affiliate
 * code via free anon requests, minting redeemable_earnings out of nothing.
 *
 * These tests drive the REAL billUsage. Only the pure downstream boundaries are
 * stubbed (pricing math + the affiliate lookup + the earnings/usage/generation
 * side-effect writers); the affiliate GUARD under test runs for real, so each
 * test fails if the guard regresses.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";

import * as realPricing from "../../pricing";
import * as realCredits from "../credits";

// Deterministic cost so the affiliate math is predictable (no pricing catalog).
mock.module("../../pricing", () => ({
  ...realPricing,
  calculateCost: mock(async () => ({ inputCost: 0.1, outputCost: 0.2, totalCost: 0.3 })),
}));

// Active affiliate code (10% markup) owned by AFFILIATE_USER by default.
const AFFILIATE_USER = "00000000-0000-4000-8000-00000000aff1";
const AFFILIATE_CODE_ID = "00000000-0000-4000-8000-00000000a001";
let affiliateUserId = AFFILIATE_USER;
mock.module("../../../db/repositories/affiliates", () => ({
  affiliatesRepository: {
    getAffiliateCodeByCode: mock(async () => ({
      id: AFFILIATE_CODE_ID,
      user_id: affiliateUserId,
      markup_percent: "10",
      is_active: true,
    })),
  },
}));
mock.module("../../../db/repositories/subscription-entitlements", () => ({
  subscriptionEntitlementsRepository: {
    find: mock(async () => undefined),
  },
}));

// The outbox processor is the post-settlement cashable-earnings boundary.
const processAffiliatePayoutBySource = mock(async () => ({
  processed: true,
  ledgerEntryId: "00000000-0000-4000-8000-00000000fee1",
}));
mock.module("../affiliate-payout-outbox", () => ({
  AFFILIATE_PAYOUT_CONTRACT_VERSION: 1,
  processAffiliatePayoutBySource,
}));

const reserve = mock(async (params: unknown) => ({
  reservedAmount: 0,
  reservationTransactionId: "reservation-1",
  reconcile: mock(async () => undefined),
  params,
}));
mock.module("../credits", () => ({
  ...realCredits,
  creditsService: { ...realCredits.creditsService, reserve },
}));

// Side-effect writers billUsage calls — stub so the test needs no DB rows.
mock.module("../usage", () => ({
  usageService: { recordUsage: mock(async () => undefined), record: mock(async () => undefined) },
}));
mock.module("../generations", () => ({
  generationsService: { record: mock(async () => undefined), create: mock(async () => undefined) },
}));

const { billFlatUsage, billUsage, reserveCredits } = await import("../ai-billing");

const USAGE = { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 };
const BASE = {
  userId: "00000000-0000-4000-8000-00000000user",
  model: "openai/gpt-oss-120b",
  provider: "openai",
  affiliateCode: "PARTNER10",
};

beforeEach(() => {
  affiliateUserId = AFFILIATE_USER;
  processAffiliatePayoutBySource.mockClear();
  reserve.mockClear();
});

const ATTRIBUTION = {
  affiliateCodeId: AFFILIATE_CODE_ID,
  affiliateUserId: AFFILIATE_USER,
  affiliateCode: "PARTNER10",
  markupPercent: 0.1,
};

function payoutReservation(
  sourceId: string,
  reconcile = mock(async (actualCost: number) => ({
    reservedAmount: actualCost,
    actualCost,
    reservationTransactionId: "reservation-1",
    settlementTransactionIds: [],
    adjustmentType: "none" as const,
  })),
) {
  return {
    reservedAmount: 1,
    reservationTransactionId: "reservation-1",
    affiliateAttribution: ATTRIBUTION,
    affiliatePayoutSourceId: sourceId,
    reconcile,
  };
}

describe("billUsage affiliate earnings guard (#10853)", () => {
  test("anonymous request with an affiliate code mints NO affiliate earnings", async () => {
    const result = await billUsage({ ...BASE, organizationId: "anonymous" }, USAGE);

    // The load-bearing assertion: no cashable earnings created for a $0 request.
    expect(processAffiliatePayoutBySource).not.toHaveBeenCalled();
    // And the affiliate markup was not layered onto the (uncollected) cost.
    expect(result.totalCost).toBeCloseTo(0.3, 6);
  });

  test("a real paying org settles the payout-aware reservation without projecting inline", async () => {
    const result = await billUsage(
      { ...BASE, organizationId: "00000000-0000-4000-8000-0000000000org" },
      USAGE,
      payoutReservation("ai_billing:affiliate:paying-org"),
    );

    expect(processAffiliatePayoutBySource).not.toHaveBeenCalled();
    // Affiliate markup was layered onto the charged cost for the paying org.
    expect(result.totalCost).toBeCloseTo(0.3 + 0.03, 6);
  });

  test("paying org self-referral via request affiliate code is ignored", async () => {
    affiliateUserId = BASE.userId;

    const result = await billUsage(
      { ...BASE, organizationId: "00000000-0000-4000-8000-0000000000org" },
      USAGE,
    );

    expect(processAffiliatePayoutBySource).not.toHaveBeenCalled();
    expect(result.totalCost).toBeCloseTo(0.3, 6);
  });

  test("uncollectable overage does not mint affiliate earnings", async () => {
    const reconcile = mock(async (actualCost: number) => ({
      reservedAmount: 0.3,
      actualCost,
      reservationTransactionId: "reservation-1",
      settlementTransactionIds: [],
      adjustmentType: "uncollected_overage" as const,
    }));

    const result = await billUsage(
      { ...BASE, organizationId: "00000000-0000-4000-8000-0000000000org" },
      USAGE,
      {
        ...payoutReservation("ai_billing:affiliate:uncollected", reconcile),
        reservedAmount: 0.3,
        reconcile,
      },
    );

    expect(result.totalCost).toBeCloseTo(0.33, 6);
    expect(reconcile).toHaveBeenCalledWith(result.totalCost);
    expect(processAffiliatePayoutBySource).not.toHaveBeenCalled();
  });

  test("partially collected affiliate markup remains on the durable settlement path", async () => {
    const reconcile = mock(async (actualCost: number) => ({
      reservedAmount: 0.315,
      actualCost,
      reservationTransactionId: "reservation-partial-1",
      settlementTransactionIds: [],
      adjustmentType: "uncollected_overage" as const,
    }));

    const result = await billUsage(
      {
        ...BASE,
        organizationId: "00000000-0000-4000-8000-0000000000org",
        requestId: "req-partial-affiliate",
      },
      USAGE,
      {
        ...payoutReservation("ai_billing:affiliate:req-partial-affiliate", reconcile),
        reservedAmount: 0.315,
        reservationTransactionId: "reservation-partial-1",
      },
    );

    expect(result.totalCost).toBeCloseTo(0.33, 6);
    expect(processAffiliatePayoutBySource).not.toHaveBeenCalled();
  });

  test("flat billing uncollectable overage does not mint affiliate earnings", async () => {
    const reconcile = mock(async (actualCost: number) => ({
      reservedAmount: 1,
      actualCost,
      reservationTransactionId: "reservation-flat-1",
      settlementTransactionIds: [],
      adjustmentType: "uncollected_overage" as const,
    }));

    const result = await billFlatUsage(
      { ...BASE, organizationId: "00000000-0000-4000-8000-0000000000org" },
      { totalCost: 1, baseTotalCost: 1 / 1.2, platformMarkup: 1 - 1 / 1.2 },
      {
        ...payoutReservation("ai_billing:affiliate:flat-uncollected", reconcile),
        reservedAmount: 1,
        reservationTransactionId: "reservation-flat-1",
        reconcile,
      },
    );

    expect(result.totalCost).toBeCloseTo(1.1, 6);
    expect(reconcile).toHaveBeenCalledWith(result.totalCost);
    expect(processAffiliatePayoutBySource).not.toHaveBeenCalled();
  });

  test("pre-request reservation includes affiliate markup so payout is backed upfront", async () => {
    await reserveCredits(
      { ...BASE, organizationId: "00000000-0000-4000-8000-0000000000org" },
      1000,
      500,
    );

    expect(reserve).toHaveBeenCalledTimes(1);
    const arg = reserve.mock.calls[0][0] as {
      estimatedCostMultiplier?: number;
      metadata?: {
        affiliatePayout?: {
          sourceId?: string;
          attribution?: typeof ATTRIBUTION;
        };
      };
    };
    expect(arg.estimatedCostMultiplier).toBeCloseTo(1.1, 6);
    expect(arg.metadata?.affiliatePayout?.attribution).toEqual(ATTRIBUTION);
  });

  test("self-referral does not inflate the pre-request reservation", async () => {
    affiliateUserId = BASE.userId;

    await reserveCredits(
      { ...BASE, organizationId: "00000000-0000-4000-8000-0000000000org" },
      1000,
      500,
    );

    const arg = reserve.mock.calls[0][0] as { estimatedCostMultiplier?: number };
    expect(arg.estimatedCostMultiplier).toBeUndefined();
  });

  test("paying org affiliate settlement accepts the deterministic request source id", async () => {
    await billUsage(
      {
        ...BASE,
        organizationId: "00000000-0000-4000-8000-0000000000org",
        requestId: "req-affiliate-1",
      },
      USAGE,
      payoutReservation("ai_billing:affiliate:req-affiliate-1"),
    );
    await billUsage(
      {
        ...BASE,
        organizationId: "00000000-0000-4000-8000-0000000000org",
        requestId: "req-affiliate-1",
      },
      USAGE,
      payoutReservation("ai_billing:affiliate:req-affiliate-1"),
    );

    expect(processAffiliatePayoutBySource).not.toHaveBeenCalled();
  });

  test("affiliate ledger projection cannot add latency or fail the model response", async () => {
    processAffiliatePayoutBySource.mockRejectedValueOnce(new Error("earnings ledger unavailable"));
    const result = await billUsage(
      {
        ...BASE,
        organizationId: "00000000-0000-4000-8000-0000000000org",
        requestId: "req-affiliate-retry",
      },
      USAGE,
      payoutReservation("ai_billing:affiliate:req-affiliate-retry"),
    );
    expect(result.totalCost).toBeCloseTo(0.33, 6);
    expect(processAffiliatePayoutBySource).not.toHaveBeenCalled();
  });
});
