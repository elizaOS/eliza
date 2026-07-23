/**
 * Verifies warm organization admission never joins a database reservation.
 *
 * The cache/ledger seams are deterministic tripwires so the test proves the
 * response-facing promise ends after the balance hint read.
 */

import { beforeEach, expect, mock, test } from "bun:test";

const reserveCredits = mock(async () => {
  throw new Error("synchronous reservation must not run");
});
const writePendingInferenceCharge = mock(async () => true);
const optimisticSettle = mock(async () => null);
const deferredSettle = mock(async () => null);
let gateBalance = 50;
let eligible = true;

mock.module("../pricing", () => ({
  normalizeModelName: (model: string) => model,
  calculateCost: async () => ({ totalCost: 0.02 }),
}));
mock.module("./ai-billing", () => ({
  reserveCredits,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {
    constructor(
      readonly required: number,
      readonly available: number,
      readonly reason?: string,
    ) {
      super("insufficient");
      this.name = "InsufficientCreditsError";
    }
  },
}));
mock.module("../utils/credit-reservation", () => ({
  createCreditReservationSettler: () => optimisticSettle,
}));
mock.module("./inference-billing-fast-path", () => ({
  InferenceBalanceCacheWarmingError: class InferenceBalanceCacheWarmingError extends Error {
    constructor() {
      super("warming");
      this.name = "InferenceBalanceCacheWarmingError";
    }
  },
  createOptimisticDebitSettler: () => optimisticSettle,
  getGateBalanceUsd: async () => gateBalance,
  isOptimisticBackstopAvailable: () => true,
  isOptimisticBillingEnabled: () => true,
  isOptimisticEligible: () => eligible,
  resolveSafeBalanceThresholdUsd: () => 5,
  writePendingInferenceCharge,
}));
mock.module("./inference-billing-ledger", () => ({
  admitInferenceChargeViaLedger: async () => ({ admitted: true }),
  createLedgerDebitSettler: () => optimisticSettle,
  resolveInferenceBillingLedger: () => "kv",
}));
mock.module("./inference-billing-deferred", () => ({
  createDeferredAdmissionSettler: () => deferredSettle,
  isDeferredAdmissionEnabled: () => true,
  isOrgAdmissionRefused: () => false,
}));

const { admitOrganizationInference } = await import("./organization-inference-admission");

beforeEach(() => {
  gateBalance = 50;
  eligible = true;
  reserveCredits.mockClear();
});

test("warm deferred admission schedules the ledger and skips reserveCredits", async () => {
  const background: Promise<unknown>[] = [];
  const admission = await admitOrganizationInference({
    context: {
      organizationId: "org-1",
      userId: "user-1",
      model: "cerebras:gpt-oss-120b",
      provider: "cerebras",
      billingSource: "bitrouter",
      requestId: "request-1",
    },
    estimatedInputTokens: 100,
    estimatedOutputTokens: 50,
    executionCtx: {
      waitUntil: (promise) => background.push(promise),
    },
  });

  expect(admission.mode).toBe("deferred_kv_ledger");
  expect(background).toHaveLength(1);
  await background[0];
  expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
  expect(reserveCredits).not.toHaveBeenCalled();
  await admission.settle(0.01);
  expect(deferredSettle).toHaveBeenCalledWith(0.01);
});

test("cached low balance rejects without falling through to a database reserve", async () => {
  gateBalance = 0.001;
  eligible = false;
  const background: Promise<unknown>[] = [];

  await expect(
    admitOrganizationInference({
      context: {
        organizationId: "org-low",
        userId: "user-low",
        model: "cerebras:gpt-oss-120b",
        provider: "cerebras",
        billingSource: "bitrouter",
        requestId: "request-low",
      },
      estimatedInputTokens: 100,
      estimatedOutputTokens: 50,
      executionCtx: {
        waitUntil: (promise) => background.push(promise),
      },
    }),
  ).rejects.toMatchObject({
    name: "InsufficientCreditsError",
    available: 0.001,
    reason: "cached_balance_gate",
  });
  expect(background).toHaveLength(0);
  expect(reserveCredits).not.toHaveBeenCalled();
});
