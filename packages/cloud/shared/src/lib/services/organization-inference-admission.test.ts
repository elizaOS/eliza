/**
 * Proves Worker organization admission reads caches and writes only its
 * Durable Object lease before provider dispatch.
 *
 * The real pricing lookup runs against repository/catalog tripwires: a normal
 * cold request consumes its coalesced authoritative rates before admission,
 * while persistence remains under `waitUntil` and later requests perform zero
 * authoritative pricing calls.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { afterEach, beforeEach, expect, mock, setSystemTime, test } from "bun:test";

type PairFilters = {
  billingSource?: string;
  productFamily: string;
  chargeType: "input" | "output";
  pairs: Array<{ provider: string; model: string }>;
};

let pairReads = 0;
let fallbackReads = 0;
let catalogReads = 0;
let affiliateReads = 0;
let repositoryBlock: Promise<void> | null = null;
let affiliateRepositoryBlock: Promise<void> | null = null;
const affiliateCodeId = "11111111-1111-4111-8111-111111111111";
const affiliateUserId = "22222222-2222-4222-8222-222222222222";

function catalogRow(filters: PairFilters) {
  const pair = filters.pairs[0];
  if (!pair) throw new Error("pricing lookup did not provide a provider/model pair");
  return {
    billing_source: filters.billingSource ?? "bitrouter",
    provider: pair.provider,
    model: pair.model,
    product_family: filters.productFamily,
    charge_type: filters.chargeType,
    unit: "token",
    unit_price: filters.chargeType === "input" ? "0.000001" : "0.000004",
    dimensions: {},
    source_kind: "test_catalog",
    source_url: "https://pricing.example.test",
    fetched_at: new Date(),
    stale_after: null,
    priority: 200,
    is_override: false,
    metadata: {},
  };
}

const listActiveEntriesForProviderModelPairs = mock(async (filters: PairFilters) => {
  pairReads++;
  if (repositoryBlock) await repositoryBlock;
  return [catalogRow(filters)];
});
const listActiveEntries = mock(async () => {
  fallbackReads++;
  return [];
});
const fetchEntriesForSource = mock(async () => {
  catalogReads++;
  return [];
});
const getAffiliateCodeByCode = mock(async (code: string) => {
  affiliateReads++;
  if (affiliateRepositoryBlock) await affiliateRepositoryBlock;
  return {
    id: affiliateCodeId,
    user_id: affiliateUserId,
    code,
    parent_referral_id: null,
    markup_percent: "20.00",
    is_active: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
});

mock.module("../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntriesForProviderModelPairs,
    listActiveEntries,
  },
}));
mock.module("./ai-pricing/providers/gateway", () => ({
  fetchEntriesForSource,
}));
mock.module("../../db/repositories/affiliates", () => ({
  affiliatesRepository: {
    getAffiliateCodeByCode,
  },
}));

const reconcileReservation = mock(async () => null);
const reserveCredits = mock(
  async (context: {
    requestId?: string | null;
    affiliateAttribution?: {
      affiliateCodeId: string;
      affiliateUserId: string;
      affiliateCode: string;
      markupPercent: number;
    } | null;
  }) => {
    return {
      reservedAmount: 0.01,
      reservationTransactionId: "reservation",
      affiliateAttribution: context.affiliateAttribution ?? null,
      affiliatePayoutSourceId: context.affiliateAttribution
        ? `ai_billing:affiliate:${context.requestId}`
        : null,
      reconcile: reconcileReservation,
    };
  },
);
const reserveFlatUsageCredits = mock(async (context: { requestId?: string | null }) => ({
  reservedAmount: 0.01,
  reservationTransactionId: "flat-reservation",
  affiliateAttribution: null,
  affiliatePayoutSourceId: context.requestId ? `ai_billing:affiliate:${context.requestId}` : null,
  reconcile: reconcileReservation,
}));
let affiliateDebitError: Error | null = null;
const collectAffiliateInferenceFallback = mock(async (params: { actualCost: number }) => {
  if (affiliateDebitError) throw affiliateDebitError;
  return {
    reservedAmount: params.actualCost,
    actualCost: params.actualCost,
    collectedAmount: params.actualCost,
    reservationTransactionId: null,
    settlementTransactionIds: ["affiliate-debit"],
    adjustmentType: "none" as const,
  };
});
const debitInferenceCost = mock(async (_context: unknown, actualCostUsd: number) => ({
  status: "collected" as const,
  collectedAmountUsd: actualCostUsd,
  balanceUsd: 50 - actualCostUsd,
  transactionId: "inference-debit",
}));
const writePendingInferenceCharge = mock(async () => true);
const optimisticSettle = mock(async () => null);
const admitInferenceChargeViaLedger = mock(async () => ({ admitted: true }));
let gateBalance = 50;
let eligible = true;
let orgRefused = false;
const isOptimisticEligible = mock(() => eligible);
const acquireInferenceAdmissionLease = mock(
  async (params: { organizationId: string; requestId: string; estimatedCostUsd: number }) => ({
    organizationId: params.organizationId,
    requestId: params.requestId,
    estimatedCostUsd: params.estimatedCostUsd,
    gate: { fetch: async () => Response.json({ settled: true }) },
    providerDispatched: false,
  }),
);
const settleInferenceAdmissionLease = mock(async () => undefined);

mock.module("./ai-billing", () => ({
  reserveCredits,
  reserveFlatUsageCredits,
  getAffiliatePayoutSourceId: (context: { requestId?: string | null }) =>
    `ai_billing:affiliate:${context.requestId}`,
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
mock.module("./credits", () => ({
  COST_BUFFER: 1.5,
  creditsService: {
    collectAffiliateInferenceFallback,
  },
  MIN_RESERVATION: 0.000001,
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
  debitInferenceCost,
  getGateBalanceHint: async () => ({
    balanceUsd: gateBalance,
    balanceAt: Date.now(),
    balanceRevision: "1",
  }),
  isOptimisticBackstopAvailable: () => true,
  isOptimisticBillingEnabled: () => true,
  isOptimisticEligible,
  resolveSafeBalanceThresholdUsd: () => 5,
  scheduleOrgBalanceHintHydration: (
    _organizationId: string,
    executionCtx: { waitUntil(promise: Promise<unknown>): void },
  ) => executionCtx.waitUntil(Promise.resolve()),
  writePendingInferenceCharge,
}));
mock.module("./inference-admission-gate", () => ({
  acquireInferenceAdmissionLease,
  inferenceSettlementAmounts: (_lease: unknown, actualCostUsd: number) => ({
    balanceBackedUsd: actualCostUsd,
    gateConsumedUsd: actualCostUsd,
  }),
  InferenceAdmissionGateUnavailableError: class InferenceAdmissionGateUnavailableError extends Error {},
  InferenceAdmissionLeaseRejectedError: class InferenceAdmissionLeaseRejectedError extends Error {
    readonly requiredUsd = 1;
    readonly availableUsd = 0;
  },
  markInferenceAdmissionLeaseDispatched: async () => undefined,
  settleInferenceAdmissionLease,
}));
mock.module("./inference-billing-ledger", () => ({
  admitInferenceChargeViaLedger,
  createLedgerDebitSettler: () => optimisticSettle,
  resolveInferenceBillingLedger: () => "kv",
}));
mock.module("./inference-billing-deferred", () => ({
  isDeferredAdmissionEnabled: () => true,
  isOrgAdmissionRefused: () => orgRefused,
  markOrgAdmissionRefused: () => {
    orgRefused = true;
  },
}));

const { admitOrganizationInference } = await import("./organization-inference-admission");
const { __clearPersistedPricingCache } = await import("./ai-pricing/cache");
const { __clearInferenceAffiliateCacheState } = await import("./inference-affiliate-cache");

let modelSequence = 0;
function nextModel(): string {
  modelSequence++;
  return `cerebras:pricing-hotpath-${modelSequence}`;
}

function admissionParams(
  model: string,
  background: Promise<unknown>[],
  overrides: { affiliateCode?: string } = {},
) {
  return {
    context: {
      organizationId: "org-1",
      userId: "user-1",
      model,
      provider: "cerebras",
      billingSource: "bitrouter",
      requestId: `request-${modelSequence}`,
    },
    estimatedInputTokens: 100,
    estimatedOutputTokens: 50,
    executionCtx: {
      waitUntil: (promise: Promise<unknown>) => background.push(promise),
    },
    ...overrides,
  };
}

async function hydratePricing(model: string): Promise<void> {
  const background: Promise<unknown>[] = [];
  const admission = await admitOrganizationInference(admissionParams(model, background));
  expect(admission.mode).toBe("durable_object_debit");
  expect(background).toHaveLength(1);
  await background[0];
  acquireInferenceAdmissionLease.mockClear();
}

beforeEach(() => {
  __clearPersistedPricingCache();
  gateBalance = 50;
  eligible = true;
  orgRefused = false;
  repositoryBlock = null;
  affiliateRepositoryBlock = null;
  affiliateDebitError = null;
  pairReads = 0;
  fallbackReads = 0;
  catalogReads = 0;
  affiliateReads = 0;
  __clearInferenceAffiliateCacheState();
  reserveCredits.mockClear();
  reserveFlatUsageCredits.mockClear();
  reconcileReservation.mockClear();
  collectAffiliateInferenceFallback.mockClear();
  debitInferenceCost.mockClear();
  writePendingInferenceCharge.mockClear();
  admitInferenceChargeViaLedger.mockClear();
  optimisticSettle.mockClear();
  acquireInferenceAdmissionLease.mockClear();
  settleInferenceAdmissionLease.mockClear();
  isOptimisticEligible.mockClear();
  listActiveEntriesForProviderModelPairs.mockClear();
  listActiveEntries.mockClear();
  fetchEntriesForSource.mockClear();
  getAffiliateCodeByCode.mockClear();
});

afterEach(() => {
  setSystemTime();
});

test("cold pricing joins authoritative hydration before admission while persistence stays background", async () => {
  const model = nextModel();
  const releaseRepository = Promise.withResolvers<void>();
  repositoryBlock = releaseRepository.promise;
  const background: Promise<unknown>[] = [];

  const pending = admitOrganizationInference(admissionParams(model, background));
  const early = await Promise.race([
    pending.then(() => ({ kind: "resolved" as const })),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), 100),
    ),
  ]);

  expect(early.kind).toBe("timeout");
  expect(background).toHaveLength(1);
  expect(reserveCredits).not.toHaveBeenCalled();
  expect(acquireInferenceAdmissionLease).not.toHaveBeenCalled();

  releaseRepository.resolve();
  const admission = await pending;
  expect(admission.mode).toBe("durable_object_debit");
  await Promise.all(background);
  expect(pairReads).toBe(2);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
});

test("warm Worker admission writes only the Durable Object lease before provider dispatch", async () => {
  const model = nextModel();
  await hydratePricing(model);
  pairReads = 0;
  fallbackReads = 0;
  catalogReads = 0;
  listActiveEntriesForProviderModelPairs.mockClear();
  listActiveEntries.mockClear();
  fetchEntriesForSource.mockClear();

  const background: Promise<unknown>[] = [];
  const credential = {
    kind: "api_key" as const,
    credentialId: "key-1",
    userId: "user-1",
  };
  const admission = await admitOrganizationInference({
    ...admissionParams(model, background),
    credential,
  });
  const leaseParams = acquireInferenceAdmissionLease.mock.calls.at(-1)?.[0] as
    | {
        requestId: string;
        credential?: typeof credential;
        recovery: {
          version: number;
          kind: string;
          organizationId: string;
          requestId: string;
          model: string;
          accounting: { kind: string };
        };
      }
    | undefined;
  if (!leaseParams) throw new Error("expected inference admission lease");

  expect(admission.mode).toBe("durable_object_debit");
  expect(leaseParams.credential).toEqual(credential);
  expect(leaseParams.recovery).toMatchObject({
    version: 1,
    kind: "organization",
    organizationId: "org-1",
    requestId: leaseParams.requestId,
    model,
    accounting: { kind: "direct_debit" },
  });
  expect(background).toHaveLength(0);
  expect(debitInferenceCost).not.toHaveBeenCalled();
  expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
  expect(pairReads).toBe(0);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
  expect(reserveCredits).not.toHaveBeenCalled();
  expect(isOptimisticEligible).not.toHaveBeenCalled();

  const first = admission.settle(0.01);
  const replay = admission.settle(99);
  await expect(first).resolves.toMatchObject({
    reservedAmount: 0.01,
    actualCost: 0.01,
    collectedAmount: 0.01,
  });
  await expect(replay).resolves.toMatchObject({ actualCost: 0.01 });
  expect(debitInferenceCost).toHaveBeenCalledTimes(1);
  expect(debitInferenceCost).toHaveBeenCalledWith(
    {
      requestId: leaseParams.requestId,
      organizationId: "org-1",
      userId: "user-1",
      model,
      provider: "cerebras",
      billingSource: "bitrouter",
    },
    0.01,
    "deferred",
  );
  expect(settleInferenceAdmissionLease).toHaveBeenCalledTimes(1);
  expect(settleInferenceAdmissionLease.mock.calls[0]?.[1]).toBe(0.01);
});

test("flat Worker admission leases the fixed catalog cost without token pricing reads", async () => {
  const background: Promise<unknown>[] = [];
  const flatCost = {
    totalCost: 0.025,
    baseTotalCost: 0.02,
    platformMarkup: 0.005,
  };

  const admission = await admitOrganizationInference({
    ...admissionParams(nextModel(), background),
    flatCost,
  });
  const lease = acquireInferenceAdmissionLease.mock.calls.at(-1)?.[0] as
    | { estimatedCostUsd: number }
    | undefined;

  expect(admission.mode).toBe("durable_object_debit");
  expect(lease?.estimatedCostUsd).toBe(flatCost.totalCost);
  expect(pairReads).toBe(0);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
  expect(reserveCredits).not.toHaveBeenCalled();
  expect(reserveFlatUsageCredits).not.toHaveBeenCalled();
});

test("unknown provider cost retains the admitted estimate and wins a later zero settlement", async () => {
  const model = nextModel();
  await hydratePricing(model);
  const background: Promise<unknown>[] = [];
  const admission = await admitOrganizationInference(admissionParams(model, background));
  const leaseParams = acquireInferenceAdmissionLease.mock.calls.at(-1)?.[0] as
    | { estimatedCostUsd: number }
    | undefined;
  if (!leaseParams) throw new Error("expected inference admission lease");

  const unknown = admission.settleUnknown();
  const laterZero = admission.settle(0);

  await expect(unknown).resolves.toMatchObject({
    reservedAmount: leaseParams.estimatedCostUsd,
    actualCost: leaseParams.estimatedCostUsd,
  });
  await expect(laterZero).resolves.toMatchObject({
    actualCost: leaseParams.estimatedCostUsd,
  });
  expect(background).toHaveLength(0);
  expect(debitInferenceCost).toHaveBeenCalledTimes(1);
  expect(debitInferenceCost.mock.calls[0]?.[1]).toBe(leaseParams.estimatedCostUsd);
  expect(debitInferenceCost.mock.calls[0]?.[2]).toBe("deferred");
  expect(settleInferenceAdmissionLease).toHaveBeenCalledTimes(1);
  expect(settleInferenceAdmissionLease.mock.calls[0]?.[1]).toBeCloseTo(
    leaseParams.estimatedCostUsd,
  );
});

test("stale pricing serves immediately and refreshes only under waitUntil", async () => {
  const baseTime = new Date("2026-07-23T12:00:00.000Z");
  setSystemTime(baseTime);
  const model = nextModel();
  await hydratePricing(model);
  pairReads = 0;
  const releaseRepository = Promise.withResolvers<void>();
  repositoryBlock = releaseRepository.promise;
  setSystemTime(new Date(baseTime.getTime() + 61_000));
  const background: Promise<unknown>[] = [];

  const outcome = await Promise.race([
    admitOrganizationInference(admissionParams(model, background)).then((admission) => ({
      kind: "resolved" as const,
      admission,
    })),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), 100),
    ),
  ]);

  expect(outcome.kind).toBe("resolved");
  if (outcome.kind !== "resolved") throw new Error("stale admission joined pricing refresh");
  expect(outcome.admission.mode).toBe("durable_object_debit");
  expect(background).toHaveLength(1);
  expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
  expect(reserveCredits).not.toHaveBeenCalled();

  releaseRepository.resolve();
  await Promise.all(background);
  expect(pairReads).toBe(2);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
});

test("the exact Durable Object path admits below the KV safety threshold", async () => {
  const model = nextModel();
  await hydratePricing(model);
  gateBalance = 0.5;
  eligible = false;
  const background: Promise<unknown>[] = [];

  const admission = await admitOrganizationInference(admissionParams(model, background));

  expect(admission.mode).toBe("durable_object_debit");
  expect(acquireInferenceAdmissionLease).toHaveBeenCalledTimes(1);
  expect(isOptimisticEligible).not.toHaveBeenCalled();
  expect(reserveCredits).not.toHaveBeenCalled();
});

test("the exact Durable Object path admits when balance equals the estimate", async () => {
  const model = nextModel();
  await hydratePricing(model);
  gateBalance = 50;
  eligible = false;
  const probeBackground: Promise<unknown>[] = [];
  await admitOrganizationInference(admissionParams(model, probeBackground));
  const quotedLease = acquireInferenceAdmissionLease.mock.calls.at(-1)?.[0] as
    | { estimatedCostUsd: number }
    | undefined;
  if (!quotedLease) throw new Error("expected quoted inference lease");

  acquireInferenceAdmissionLease.mockClear();
  gateBalance = quotedLease.estimatedCostUsd;
  const background: Promise<unknown>[] = [];
  const request = admissionParams(model, background);
  request.context.requestId = `${request.context.requestId}-exact-balance`;
  const admission = await admitOrganizationInference(request);
  const lease = acquireInferenceAdmissionLease.mock.calls.at(-1)?.[0] as
    | { estimatedCostUsd: number; balanceUsd: number }
    | undefined;

  expect(admission.mode).toBe("durable_object_debit");
  expect(lease?.estimatedCostUsd).toBe(quotedLease.estimatedCostUsd);
  expect(lease?.balanceUsd).toBe(lease?.estimatedCostUsd);
  expect(isOptimisticEligible).not.toHaveBeenCalled();
  expect(reserveCredits).not.toHaveBeenCalled();
});

test("cached unaffordable balance rejects without a database reservation", async () => {
  const model = nextModel();
  await hydratePricing(model);
  pairReads = 0;
  fallbackReads = 0;
  catalogReads = 0;
  gateBalance = 0.0001;
  eligible = false;
  const background: Promise<unknown>[] = [];

  await expect(
    admitOrganizationInference(admissionParams(model, background)),
  ).rejects.toMatchObject({
    name: "InsufficientCreditsError",
    available: 0.0001,
    reason: "cached_balance_gate",
  });
  expect(background).toHaveLength(0);
  expect(pairReads).toBe(0);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
  expect(isOptimisticEligible).not.toHaveBeenCalled();
  expect(reserveCredits).not.toHaveBeenCalled();
});

test("a previously refused org fails closed and hydrates balance off path", async () => {
  orgRefused = true;
  const background: Promise<unknown>[] = [];

  await expect(
    admitOrganizationInference(admissionParams(nextModel(), background)),
  ).rejects.toMatchObject({
    name: "InferenceAdmissionUnavailableError",
  });
  expect(background).toHaveLength(1);
  expect(pairReads).toBe(0);
  expect(affiliateReads).toBe(0);
  expect(reserveCredits).not.toHaveBeenCalled();
});

test("cold affiliate pricing hydrates policy and model rates without a synchronous reserve", async () => {
  const model = nextModel();
  const background: Promise<unknown>[] = [];

  const error = await admitOrganizationInference(
    admissionParams(model, background, { affiliateCode: `PARTNER-${modelSequence}` }),
  ).then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(Error);
  expect(background).toHaveLength(2);
  expect(reserveCredits).not.toHaveBeenCalled();
  await Promise.all(background);
  expect(pairReads).toBe(2);
  expect(affiliateReads).toBe(1);
});

test("warm Worker affiliate admission has zero pre-dispatch repository calls", async () => {
  const model = nextModel();
  const affiliateCode = `PARTNER-${modelSequence}`;
  const coldBackground: Promise<unknown>[] = [];
  await admitOrganizationInference(admissionParams(model, coldBackground, { affiliateCode })).then(
    () => null,
    () => null,
  );
  await Promise.all(coldBackground);

  pairReads = 0;
  fallbackReads = 0;
  catalogReads = 0;
  affiliateReads = 0;
  reserveCredits.mockClear();
  const background: Promise<unknown>[] = [];
  const admission = await admitOrganizationInference(
    admissionParams(model, background, { affiliateCode }),
  );
  const leaseParams = acquireInferenceAdmissionLease.mock.calls.at(-1)?.[0] as
    | {
        requestId: string;
        recovery: {
          version: number;
          accounting: {
            kind: string;
            attribution: unknown;
            payoutSourceId: string;
          };
        };
      }
    | undefined;
  if (!leaseParams) throw new Error("expected affiliate inference admission lease");

  expect(admission.mode).toBe("durable_object_affiliate_debit");
  expect(reserveCredits).not.toHaveBeenCalled();
  expect(debitInferenceCost).not.toHaveBeenCalled();
  expect(collectAffiliateInferenceFallback).not.toHaveBeenCalled();
  expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
  expect(background).toHaveLength(0);
  expect(pairReads).toBe(0);
  expect(fallbackReads).toBe(0);
  expect(catalogReads).toBe(0);
  expect(affiliateReads).toBe(0);
  expect(leaseParams.recovery.accounting).toEqual({
    kind: "affiliate_debit",
    attribution: {
      affiliateCodeId,
      affiliateUserId,
      affiliateCode,
      markupPercent: 0.2,
    },
    payoutSourceId: `ai_billing:affiliate:${leaseParams.requestId}`,
  });
  expect(leaseParams.recovery.version).toBe(1);
  expect(admission.reservation).toBeDefined();
  expect(admission.affiliateAttribution).toEqual({
    affiliateCodeId,
    affiliateUserId,
    affiliateCode,
    markupPercent: 0.2,
  });
  expect(admission.reservation).toMatchObject({
    affiliateAttribution: admission.affiliateAttribution,
    affiliatePayoutSourceId: `ai_billing:affiliate:${leaseParams.requestId}`,
  });
  const first = admission.reservation?.reconcile(0.02);
  const replay = admission.reservation?.reconcile(99);
  await expect(first).resolves.toMatchObject({ actualCost: 0.02 });
  await expect(replay).resolves.toMatchObject({ actualCost: 0.02 });
  expect(collectAffiliateInferenceFallback).toHaveBeenCalledTimes(1);
  expect(collectAffiliateInferenceFallback.mock.calls[0]?.[0]).toMatchObject({
    organizationId: "org-1",
    userId: "user-1",
    requestId: leaseParams.requestId,
    model,
    provider: "cerebras",
    billingSource: "bitrouter",
    actualCost: 0.02,
    reservationMetadata: {
      affiliatePayout: {
        sourceId: `ai_billing:affiliate:${leaseParams.requestId}`,
        attribution: admission.affiliateAttribution,
        model,
      },
    },
  });
  expect(settleInferenceAdmissionLease).toHaveBeenCalledTimes(1);
  expect(settleInferenceAdmissionLease.mock.calls[0]?.[1]).toBe(0.02);
});

test("affiliate settlement retries the same post-provider amount after infrastructure failure", async () => {
  const model = nextModel();
  const affiliateCode = `PARTNER-${modelSequence}`;
  const coldBackground: Promise<unknown>[] = [];
  await admitOrganizationInference(admissionParams(model, coldBackground, { affiliateCode })).then(
    () => null,
    () => null,
  );
  await Promise.all(coldBackground);

  affiliateDebitError = new Error("affiliate debit database unavailable");
  const background: Promise<unknown>[] = [];
  const admission = await admitOrganizationInference(
    admissionParams(model, background, { affiliateCode }),
  );
  expect(admission.mode).toBe("durable_object_affiliate_debit");
  expect(background).toHaveLength(0);

  await expect(admission.settle(0.02)).rejects.toBe(affiliateDebitError);
  expect(collectAffiliateInferenceFallback).toHaveBeenCalledTimes(1);
  expect(collectAffiliateInferenceFallback.mock.calls[0]?.[0].actualCost).toBe(0.02);
  expect(settleInferenceAdmissionLease).not.toHaveBeenCalled();
  expect(orgRefused).toBe(false);

  affiliateDebitError = null;
  await expect(admission.settle(99)).resolves.toMatchObject({
    actualCost: 0.02,
  });
  expect(collectAffiliateInferenceFallback).toHaveBeenCalledTimes(2);
  expect(collectAffiliateInferenceFallback.mock.calls[1]?.[0].actualCost).toBe(0.02);
  expect(settleInferenceAdmissionLease).toHaveBeenCalledTimes(1);
  expect(settleInferenceAdmissionLease.mock.calls[0]?.[1]).toBe(0.02);
});

test("non-Worker affiliate admission keeps synchronous reservation compatibility", async () => {
  const model = nextModel();
  const admission = await admitOrganizationInference({
    ...admissionParams(model, [], { affiliateCode: "PARTNER-NODE" }),
    executionCtx: undefined,
  });

  expect(admission.mode).toBe("synchronous_reservation");
  expect(reserveCredits).toHaveBeenCalledTimes(1);
  expect(pairReads).toBe(0);
  expect(affiliateReads).toBe(0);
});

test("non-Worker KV-ledger admission reserves instead of trusting a balance projection", async () => {
  const model = nextModel();
  const admission = await admitOrganizationInference({
    ...admissionParams(model, []),
    executionCtx: undefined,
  });

  expect(admission.mode).toBe("synchronous_reservation");
  expect(reserveCredits).toHaveBeenCalledTimes(1);
  expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
  expect(isOptimisticEligible).not.toHaveBeenCalled();
});
