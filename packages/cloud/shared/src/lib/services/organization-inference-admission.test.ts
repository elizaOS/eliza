/**
 * Verifies warm organization admission never joins a database reservation.
 *
 * The cache/ledger seams are deterministic tripwires so the test proves the
 * response-facing promise ends after the balance hint read.
 */

import { beforeEach, expect, mock, test } from "bun:test";

const reserveCredits = mock(async () => ({ reservationId: "res-1" }));
const writePendingInferenceCharge = mock(async () => true);
const optimisticSettle = mock(async () => null);
const deferredSettle = mock(async () => null);
let gateBalance = 50;
let eligible = true;
let optimisticEnabled = true;
let orgRefused = false;

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
  isOptimisticBillingEnabled: () => optimisticEnabled,
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
  isOrgAdmissionRefused: () => orgRefused,
}));

const { admitOrganizationInference } = await import("./organization-inference-admission");

beforeEach(() => {
  gateBalance = 50;
  eligible = true;
  optimisticEnabled = true;
  orgRefused = false;
  reserveCredits.mockClear();
});

function admissionParams(suffix: string, background: Promise<unknown>[]) {
  return {
    context: {
      organizationId: `org-${suffix}`,
      userId: `user-${suffix}`,
      model: "cerebras:gpt-oss-120b",
      provider: "cerebras",
      billingSource: "bitrouter",
      requestId: `request-${suffix}`,
    },
    estimatedInputTokens: 100,
    estimatedOutputTokens: 50,
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    },
  };
}

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

test("ineligible cached balance falls back to the synchronous reserve (threshold is not a service floor)", async () => {
  gateBalance = 4.99;
  eligible = false;
  const background: Promise<unknown>[] = [];

  const admission = await admitOrganizationInference(admissionParams("low", background));

  // A funded org below SAFE_BALANCE_THRESHOLD must still be served through the
  // fail-closed Postgres reservation — the reserve, not a cached hint, is the
  // authoritative producer of the real 402.
  expect(admission.mode).toBe("synchronous_reservation");
  expect(background).toHaveLength(0);
  expect(reserveCredits).toHaveBeenCalledTimes(1);
});

test("optimistic billing disabled falls back to the synchronous reserve on Workers too", async () => {
  optimisticEnabled = false;
  const background: Promise<unknown>[] = [];

  const admission = await admitOrganizationInference(admissionParams("off", background));

  // Flag rollback must restore the documented OFF semantics (sync reserve),
  // never a permanent fake-"warming" 503.
  expect(admission.mode).toBe("synchronous_reservation");
  expect(reserveCredits).toHaveBeenCalledTimes(1);
});

test("a recently refused org skips the deferred path and re-proves via the reserve", async () => {
  orgRefused = true;
  const background: Promise<unknown>[] = [];

  const admission = await admitOrganizationInference(admissionParams("refused", background));

  expect(admission.mode).toBe("synchronous_reservation");
  expect(reserveCredits).toHaveBeenCalledTimes(1);
});
