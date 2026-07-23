/**
 * Exercises expired inference-lease recovery with deterministic accounting
 * doubles, including replay identity and conservative settlement per lane.
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";

const collectAffiliateInferenceFallback = mock();
const getOrganizationBalanceSnapshot = mock();
const findAppById = mock();
const reserveInferenceCredits = mock();
const debitInferenceCost = mock();

mock.module("./credits", () => ({
  MIN_RESERVATION: 0.000001,
  creditsService: {
    collectAffiliateInferenceFallback,
    getOrganizationBalanceSnapshot,
  },
}));

mock.module("../../db/repositories/apps", () => ({
  appsRepository: { findByIdInOrganizationForWrite: findAppById },
}));

mock.module("./app-credits", () => ({
  appCreditsService: { reserveInferenceCredits },
}));

mock.module("./affiliate-payout-outbox", () => ({
  AFFILIATE_PAYOUT_CONTRACT_VERSION: 1,
}));

mock.module("./inference-billing-fast-path", () => ({
  debitInferenceCost,
}));

const { recoverExpiredInferenceAdmissionLease } = await import("./inference-admission-recovery");

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const CREATOR_ID = "00000000-0000-4000-8000-000000000003";
const AFFILIATE_ID = "00000000-0000-4000-8000-000000000004";
const AFFILIATE_CODE_ID = "00000000-0000-4000-8000-000000000005";
const APP_ID = "00000000-0000-4000-8000-000000000006";

function organizationContext() {
  return {
    version: 1 as const,
    kind: "organization" as const,
    organizationId: ORGANIZATION_ID,
    requestId: "request-1",
    userId: USER_ID,
    model: "openai/gpt-4o-mini",
    provider: "openai",
    billingSource: "gateway",
    description: "Recovered inference",
    metadata: { tenantTrace: "trace-1" },
    accounting: { kind: "direct_debit" as const },
  };
}

function affiliateContext() {
  return {
    ...organizationContext(),
    accounting: {
      kind: "affiliate_debit" as const,
      attribution: {
        affiliateCodeId: AFFILIATE_CODE_ID,
        affiliateUserId: AFFILIATE_ID,
        affiliateCode: "partner",
        markupPercent: 0.2,
      },
      payoutSourceId: "ai_billing:affiliate:request-1",
    },
  };
}

function appContext() {
  return {
    version: 1 as const,
    kind: "app" as const,
    organizationId: ORGANIZATION_ID,
    requestId: "request-app-1",
    userId: USER_ID,
    model: "openai/gpt-4o-mini",
    provider: "openai",
    billingSource: "gateway",
    description: "Recovered app inference",
    metadata: { tenantTrace: "trace-app-1" },
    appId: APP_ID,
    estimatedBaseCostUsd: 0.5,
    appPolicy: {
      name: "Pinned app",
      creatorUserId: CREATOR_ID,
      monetizationEnabled: true,
      reviewStatus: "approved" as const,
      platformOffsetAmount: 1,
      purchaseSharePercentage: 30,
      inferenceMarkupPercentage: 20,
    },
  };
}

beforeEach(() => {
  collectAffiliateInferenceFallback.mockReset();
  getOrganizationBalanceSnapshot.mockReset();
  findAppById.mockReset();
  reserveInferenceCredits.mockReset();
  debitInferenceCost.mockReset();

  getOrganizationBalanceSnapshot.mockResolvedValue({
    balanceUsd: 9.5,
    revision: "42",
  });
});

afterAll(() => {
  mock.restore();
});

test("direct recovery replays one deterministic debit and returns the persisted winner", async () => {
  debitInferenceCost.mockResolvedValue({
    status: "collected",
    attemptedAmountUsd: 0.3,
    collectedAmountUsd: 0.2,
    newBalanceUsd: 9.5,
    transactionId: "transaction-1",
  });

  const first = await recoverExpiredInferenceAdmissionLease(organizationContext(), 0.3);
  const replay = await recoverExpiredInferenceAdmissionLease(organizationContext(), 0.3);

  expect(debitInferenceCost).toHaveBeenCalledTimes(2);
  expect(debitInferenceCost).toHaveBeenNthCalledWith(
    1,
    {
      requestId: "request-1",
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      model: "openai/gpt-4o-mini",
      provider: "openai",
      billingSource: "gateway",
    },
    0.3,
    "backstop",
  );
  expect(first).toEqual({
    balanceUsd: 9.5,
    balanceRevision: "42",
    collectedUsd: 0.2,
    gateConsumedUsd: 0.3,
  });
  expect(replay).toEqual(first);
  expect(collectAffiliateInferenceFallback).not.toHaveBeenCalled();
});

test("an uncollected direct debit consumes the lease estimate without switching lanes", async () => {
  debitInferenceCost.mockResolvedValue({
    status: "uncollected",
    attemptedAmountUsd: 0.3,
    collectedAmountUsd: 0,
    newBalanceUsd: 0,
    transactionId: null,
    reason: "insufficient_balance",
  });

  await expect(recoverExpiredInferenceAdmissionLease(organizationContext(), 0.3)).resolves.toEqual({
    balanceUsd: 9.5,
    balanceRevision: "42",
    collectedUsd: 0,
    gateConsumedUsd: 0.3,
  });
  expect(collectAffiliateInferenceFallback).not.toHaveBeenCalled();
});

test("affiliate recovery replays the atomic debit and payout identity", async () => {
  collectAffiliateInferenceFallback.mockResolvedValue({
    reservedAmount: 0.2,
    actualCost: 0.3,
    settlementTransactionIds: ["affiliate-debit-1"],
    adjustmentType: "uncollected_overage",
  });

  const first = await recoverExpiredInferenceAdmissionLease(affiliateContext(), 0.3);
  const replay = await recoverExpiredInferenceAdmissionLease(affiliateContext(), 0.3);

  expect(collectAffiliateInferenceFallback).toHaveBeenCalledTimes(2);
  expect(collectAffiliateInferenceFallback).toHaveBeenNthCalledWith(1, {
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    requestId: "request-1",
    model: "openai/gpt-4o-mini",
    provider: "openai",
    billingSource: "gateway",
    actualCost: 0.3,
    reservationMetadata: {
      tenantTrace: "trace-1",
      affiliatePayout: {
        version: 1,
        sourceId: "ai_billing:affiliate:request-1",
        attribution: affiliateContext().accounting.attribution,
        model: "openai/gpt-4o-mini",
      },
    },
  });
  expect(first.gateConsumedUsd).toBe(0.3);
  expect(first.collectedUsd).toBe(0.2);
  expect(replay).toEqual(first);
  expect(debitInferenceCost).not.toHaveBeenCalled();
});

test("affiliate replay keeps an older partial winner consumed by the current lease", async () => {
  collectAffiliateInferenceFallback.mockResolvedValue({
    reservedAmount: 0.2,
    actualCost: 0.2,
    collectedAmount: 0.2,
    settlementTransactionIds: ["affiliate-debit-1"],
    adjustmentType: "none",
  });

  await expect(recoverExpiredInferenceAdmissionLease(affiliateContext(), 0.3)).resolves.toEqual({
    balanceUsd: 9.5,
    balanceRevision: "42",
    collectedUsd: 0.2,
    gateConsumedUsd: 0.3,
  });
});

test("malformed affiliate identity fails before any accounting mutation", async () => {
  await expect(
    recoverExpiredInferenceAdmissionLease(
      {
        ...affiliateContext(),
        accounting: {
          ...affiliateContext().accounting,
          attribution: {
            ...affiliateContext().accounting.attribution,
            affiliateUserId: USER_ID,
          },
        },
      },
      0.3,
    ),
  ).rejects.toThrow("Affiliate inference recovery requires pinned attribution and payout identity");
  await expect(
    recoverExpiredInferenceAdmissionLease(
      {
        ...affiliateContext(),
        accounting: {
          ...affiliateContext().accounting,
          payoutSourceId: " payout-with-edge-whitespace",
        },
      },
      0.3,
    ),
  ).rejects.toThrow("Affiliate inference recovery requires pinned attribution and payout identity");
  expect(collectAffiliateInferenceFallback).not.toHaveBeenCalled();
  expect(debitInferenceCost).not.toHaveBeenCalled();
});

test("app recovery pins dispatch-time policy and settles the full conservative hold", async () => {
  findAppById.mockResolvedValue({
    id: APP_ID,
    name: "Mutable app name",
    created_by_user_id: AFFILIATE_ID,
    monetization_enabled: false,
    review_status: "rejected",
    platform_offset_amount: 99,
    purchase_share_percentage: 99,
    inference_markup_percentage: 0,
  });
  const reconcile = mock(async () => ({
    reservedAmount: 0.6,
    actualCost: 0.6,
    collectedAmount: 0.6,
    settlementTransactionIds: [],
    adjustmentType: "none" as const,
  }));
  reserveInferenceCredits.mockResolvedValue({
    reservedAmount: 0.6,
    reservationTransactionId: "app-reservation-1",
    reconcile,
  });

  await recoverExpiredInferenceAdmissionLease(appContext(), 0.6);
  await recoverExpiredInferenceAdmissionLease(appContext(), 0.6);

  expect(findAppById.mock.calls).toEqual([
    [APP_ID, ORGANIZATION_ID],
    [APP_ID, ORGANIZATION_ID],
  ]);
  expect(reserveInferenceCredits).toHaveBeenCalledTimes(2);
  const firstParams = reserveInferenceCredits.mock.calls[0][0];
  expect(firstParams).toMatchObject({
    appId: APP_ID,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    estimatedBaseCost: 0.5,
    idempotencyKey: "request-app-1",
    retainChargeOnPostDebitFailure: true,
    metadata: { tenantTrace: "trace-app-1" },
    app: {
      name: "Pinned app",
      created_by_user_id: CREATOR_ID,
      monetization_enabled: true,
      review_status: "approved",
      platform_offset_amount: 1,
      purchase_share_percentage: 30,
      inference_markup_percentage: 20,
    },
  });
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(reconcile).toHaveBeenCalledWith(0.5);
});

test("app reservation amount mismatch cannot release the admission lease", async () => {
  findAppById.mockResolvedValue({
    id: APP_ID,
    name: "Mutable app name",
    created_by_user_id: AFFILIATE_ID,
  });
  const reconcile = mock();
  reserveInferenceCredits.mockResolvedValue({
    reservedAmount: 0.61,
    reservationTransactionId: "app-reservation-1",
    reconcile,
  });

  await expect(recoverExpiredInferenceAdmissionLease(appContext(), 0.6)).rejects.toThrow(
    "app inference recovery amount mismatch for request-app-1",
  );
  expect(reconcile).not.toHaveBeenCalled();
  expect(getOrganizationBalanceSnapshot).not.toHaveBeenCalled();
});

test("deleted app recovery uses pinned economics and skips FK-backed shadows", async () => {
  findAppById.mockResolvedValue(undefined);
  const reconcile = mock(async () => ({
    reservedAmount: 0.6,
    actualCost: 0.6,
    collectedAmount: 0.6,
    settlementTransactionIds: [],
    adjustmentType: "none" as const,
  }));
  reserveInferenceCredits.mockResolvedValue({
    reservedAmount: 0.6,
    reservationTransactionId: "app-reservation-1",
    reconcile,
  });

  await expect(recoverExpiredInferenceAdmissionLease(appContext(), 0.6)).resolves.toEqual({
    balanceUsd: 9.5,
    balanceRevision: "42",
    collectedUsd: 0.6,
    gateConsumedUsd: 0.6,
  });
  expect(reserveInferenceCredits.mock.calls[0][0]).toMatchObject({
    appId: APP_ID,
    idempotencyKey: "request-app-1",
    app: {
      id: APP_ID,
      name: "Pinned app",
      created_by_user_id: CREATOR_ID,
      monetization_enabled: true,
      review_status: "approved",
      inference_markup_percentage: 20,
      persistAppEarnings: false,
    },
  });
  expect(reconcile).toHaveBeenCalledWith(0.5);
});

test("app recovery releases only reconciled actual cost after a refund", async () => {
  findAppById.mockResolvedValue({
    id: APP_ID,
    name: "Current app",
    created_by_user_id: CREATOR_ID,
  });
  const reconcile = mock(async () => ({
    reservedAmount: 0.6,
    actualCost: 0.4,
    collectedAmount: 0.4,
    settlementTransactionIds: ["app-refund-1"],
    adjustmentType: "refund" as const,
  }));
  reserveInferenceCredits.mockResolvedValue({
    reservedAmount: 0.6,
    reservationTransactionId: "app-reservation-1",
    reconcile,
  });

  await expect(recoverExpiredInferenceAdmissionLease(appContext(), 0.6)).resolves.toEqual({
    balanceUsd: 9.5,
    balanceRevision: "42",
    collectedUsd: 0.4,
    gateConsumedUsd: 0.4,
  });
});

test("app uncollected overage retains the larger actual cost in the gate", async () => {
  findAppById.mockResolvedValue({
    id: APP_ID,
    name: "Current app",
    created_by_user_id: CREATOR_ID,
  });
  const reconcile = mock(async () => ({
    reservedAmount: 0.6,
    actualCost: 0.9,
    collectedAmount: 0.6,
    settlementTransactionIds: [],
    adjustmentType: "uncollected_overage" as const,
  }));
  reserveInferenceCredits.mockResolvedValue({
    reservedAmount: 0.6,
    reservationTransactionId: "app-reservation-1",
    reconcile,
  });

  await expect(recoverExpiredInferenceAdmissionLease(appContext(), 0.6)).resolves.toEqual({
    balanceUsd: 9.5,
    balanceRevision: "42",
    collectedUsd: 0.6,
    gateConsumedUsd: 0.9,
  });
});
