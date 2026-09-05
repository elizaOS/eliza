/**
 * Verifies synchronous AI billing selects allowance-aware funding for paid
 * organizations while retaining the legacy CreditReservation contract.
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const CREATED_AT = new Date("2026-08-20T12:00:00.000Z");
let subscriptionFunded = true;
let affiliateEnabled = false;

const findEntitlement = mock(async () =>
  subscriptionFunded ? { plan_key: "plus_monthly" } : { plan_key: "free" },
);
mock.module("../../db/repositories/subscription-entitlements", () => ({
  subscriptionEntitlementsRepository: { find: findEntitlement },
}));

const getAffiliateCodeByCode = mock(async () =>
  affiliateEnabled
    ? {
        id: "11111111-1111-4111-8111-111111111111",
        user_id: "22222222-2222-4222-8222-222222222222",
        code: "PARTNER",
        markup_percent: "20.00",
        is_active: true,
      }
    : undefined,
);
mock.module("../../db/repositories/affiliates", () => ({
  affiliatesRepository: { getAffiliateCodeByCode },
}));

const legacyReserve = mock(async () => ({
  reservedAmount: 0.015,
  reservationTransactionId: "legacy-reservation",
  reconcile: async () => undefined,
}));
mock.module("./credits", () => ({
  COST_BUFFER: 1.5,
  MIN_RESERVATION: 0.000001,
  RESERVATION_SWEEP_GRACE_MS: 7_200_000,
  creditsService: { reserve: legacyReserve },
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

const fundingReserve = mock(async () => ({
  reservation: {
    id: "funding-root",
    requested_amount: affiliateEnabled ? "0.018000" : "0.015000",
    created_at: CREATED_AT,
  },
  replayed: false,
}));
const fundingSettle = mock(async () => ({
  reservation: { id: "funding-root" },
  replayed: false,
  collectedAmount: "0.015000",
  uncollectedOverageAmount: "0.005000",
}));
mock.module("./subscription-funding", () => ({
  subscriptionFundingService: { reserve: fundingReserve, settle: fundingSettle },
}));

mock.module("../pricing", () => ({
  PLATFORM_MARKUP_MULTIPLIER: 1.2,
  calculateCost: async () => ({
    inputCost: 0.006,
    outputCost: 0.004,
    totalCost: 0.01,
  }),
  estimateTokens: () => 1,
  getProviderFromModel: () => "test-provider",
  normalizeModelName: (model: string) => model,
}));
mock.module("./affiliate-payout-outbox", () => ({
  AFFILIATE_PAYOUT_CONTRACT_VERSION: 1,
}));
mock.module("./generations", () => ({ generationsService: { create: mock() } }));
mock.module("./usage", () => ({ usageService: { create: mock() } }));
mock.module("../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock() },
}));

const { reserveCredits } = await import("./ai-billing");

afterAll(() => {
  mock.restore();
});

function billingContext() {
  return {
    organizationId: "33333333-3333-4333-8333-333333333333",
    userId: "44444444-4444-4444-8444-444444444444",
    model: "test-model",
    provider: "test-provider",
    billingSource: "bitrouter" as const,
    requestId: "req-exact-12345",
    ...(affiliateEnabled ? { affiliateCode: "PARTNER" } : {}),
  };
}

beforeEach(() => {
  subscriptionFunded = true;
  affiliateEnabled = false;
  findEntitlement.mockClear();
  getAffiliateCodeByCode.mockClear();
  legacyReserve.mockClear();
  fundingReserve.mockClear();
  fundingSettle.mockClear();
});

test("paid inference reserves and settles with the exact request identity", async () => {
  const reservation = await reserveCredits(billingContext(), 100, 50);

  expect(legacyReserve).not.toHaveBeenCalled();
  expect(fundingReserve).toHaveBeenCalledWith(
    expect.objectContaining({
      logicalOperationId: "inference-gate:req-exact-12345",
      operation: "ai_inference",
      amount: "0.015000",
      reservationTtlMs: 7_200_000,
    }),
  );
  expect(reservation).toMatchObject({
    reservedAmount: 0.015,
    reservationTransactionId: "funding-root",
  });

  await expect(reservation.reconcile(0.02)).resolves.toMatchObject({
    reservedAmount: 0.015,
    actualCost: 0.02,
    collectedAmount: 0.015,
    adjustmentType: "uncollected_overage",
    settlementTransactionIds: ["funding-root"],
  });
  expect(fundingSettle).toHaveBeenCalledWith(
    expect.objectContaining({
      logicalOperationId: "inference-gate:req-exact-12345",
      operation: "ai_inference",
      actualAmount: "0.020000",
      occurredAt: CREATED_AT,
    }),
  );
});

test("affiliate attribution and payout identity stay pinned across funding settlement", async () => {
  affiliateEnabled = true;

  const reservation = await reserveCredits(billingContext(), 100, 50);
  await reservation.reconcile(0.012);

  const payoutContract = {
    version: 1,
    sourceId: "ai_billing:affiliate:req-exact-12345",
    attribution: {
      affiliateCodeId: "11111111-1111-4111-8111-111111111111",
      affiliateUserId: "22222222-2222-4222-8222-222222222222",
      affiliateCode: "PARTNER",
      markupPercent: 0.2,
    },
    model: "test-model",
  };
  expect(fundingReserve.mock.calls[0]?.[0]).toMatchObject({
    amount: "0.018000",
    metadata: { affiliatePayout: payoutContract },
  });
  expect(fundingSettle.mock.calls[0]?.[0]).toMatchObject({
    metadata: { affiliatePayout: payoutContract },
  });
  expect(reservation).toMatchObject({
    affiliateAttribution: payoutContract.attribution,
    affiliatePayoutSourceId: payoutContract.sourceId,
  });
});

test("free organizations retain the legacy purchased-credit reservation", async () => {
  subscriptionFunded = false;

  const reservation = await reserveCredits(billingContext(), 100, 50);

  expect(fundingReserve).not.toHaveBeenCalled();
  expect(legacyReserve).toHaveBeenCalledTimes(1);
  expect(reservation.reservationTransactionId).toBe("legacy-reservation");
});
