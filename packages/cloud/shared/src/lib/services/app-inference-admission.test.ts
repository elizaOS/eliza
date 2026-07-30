/**
 * Verifies monetized-app admission uses the Durable Object lease as its only
 * pre-dispatch WAL, then creates deterministic app accounting at settlement.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { App } from "../../db/repositories/apps";

class TestInsufficientCreditsError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
    readonly reason: string,
  ) {
    super("Insufficient credits");
    this.name = "InsufficientCreditsError";
  }
}

let cachedBalanceUsd = 100;
let gateError: Error | null = null;
let gateReads = 0;
let reserveCalls = 0;
let reserveArgs: Array<{ estimatedBaseCost: number; idempotencyKey: string }> = [];
let reserveImpl: (params: { estimatedBaseCost: number; idempotencyKey: string }) => Promise<{
  reservedAmount: number;
  reservationTransactionId: string | null;
  reconcile(actualCost: number): Promise<{
    reservedAmount: number;
    actualCost: number;
    reservationTransactionId: string | null;
    settlementTransactionIds: string[];
    adjustmentType: "none" | "refund" | "overage" | "uncollected_overage";
  } | null>;
}>;
let invalidations = 0;
let hintWrites: number[] = [];
let hintWriteError: Error | null = null;
let refusalMarks: string[] = [];
let refusalClears: string[] = [];
let authoritativeBalanceUsd = 80;
let usageProjections: string[] = [];
const acquireInferenceAdmissionLease = mock(
  async (params: { organizationId: string; requestId: string; estimatedCostUsd: number }) => ({
    organizationId: params.organizationId,
    requestId: params.requestId,
    estimatedCostUsd: params.estimatedCostUsd,
    gate: { fetch: async () => Response.json({ settled: true }) },
  }),
);
const settleInferenceAdmissionLease = mock(async () => undefined);

mock.module("./app-credits", () => ({
  appCreditsService: {
    reserveInferenceCredits: async (params: {
      estimatedBaseCost: number;
      idempotencyKey: string;
    }) => {
      reserveCalls += 1;
      reserveArgs.push(params);
      return await reserveImpl(params);
    },
  },
}));

mock.module("./credits", () => ({
  creditsService: {
    getOrganizationBalanceSnapshot: async () => ({
      balanceUsd: authoritativeBalanceUsd,
      revision: "2",
    }),
  },
  InsufficientCreditsError: TestInsufficientCreditsError,
  MIN_RESERVATION: 0.000001,
}));

mock.module("./inference-auth-cache", () => ({
  invalidateOrgBalanceHint: async () => {
    invalidations += 1;
  },
  writeOrgBalanceHint: async (_organizationId: string, balanceUsd: number) => {
    if (hintWriteError) throw hintWriteError;
    hintWrites.push(balanceUsd);
  },
}));

mock.module("./inference-billing-fast-path", () => ({
  InferenceBalanceCacheWarmingError: class InferenceBalanceCacheWarmingError extends Error {},
  getGateBalanceHint: async (
    _organizationId: string,
    options: {
      executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    },
  ) => {
    gateReads += 1;
    if (gateError) {
      options.executionCtx?.waitUntil(Promise.resolve());
      throw gateError;
    }
    return {
      balanceUsd: cachedBalanceUsd,
      balanceAt: Date.now(),
      balanceRevision: "1",
    };
  },
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

mock.module("./app-usage-projections", () => ({
  projectAppUsageForDebit: async (transactionId: string) => {
    usageProjections.push(transactionId);
  },
}));

mock.module("./inference-billing-deferred", () => ({
  clearOrgAdmissionRefused: (organizationId: string) => {
    refusalClears.push(organizationId);
  },
  markOrgAdmissionRefused: (organizationId: string) => {
    refusalMarks.push(organizationId);
  },
}));

const { __clearAppInferenceAdmissionStateForTests, admitAppInferenceCacheOnly } = await import(
  "./app-inference-admission"
);

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function monetizedApp(): App {
  return {
    id: "app-1",
    name: "App",
    slug: "app",
    organization_id: "creator-org",
    created_by_user_id: "creator",
    app_url: "https://app.example",
    monetization_enabled: true,
    inference_markup_percentage: "20",
  } as App;
}

function params(executionCtx: { waitUntil(promise: Promise<unknown>): void }) {
  return {
    app: monetizedApp(),
    appId: "app-1",
    userId: "user-1",
    organizationId: "org-1",
    estimatedBaseCostUsd: 1,
    description: "test inference",
    idempotencyKey: "idem-1",
    metadata: { route: "test" },
    requestId: "request-1",
    model: "model-1",
    provider: "provider-1",
    billingSource: "gateway",
    executionCtx,
  };
}

beforeEach(() => {
  __clearAppInferenceAdmissionStateForTests();
  cachedBalanceUsd = 100;
  gateError = null;
  gateReads = 0;
  reserveCalls = 0;
  reserveArgs = [];
  invalidations = 0;
  hintWrites = [];
  hintWriteError = null;
  refusalMarks = [];
  refusalClears = [];
  usageProjections = [];
  acquireInferenceAdmissionLease.mockClear();
  settleInferenceAdmissionLease.mockClear();
  authoritativeBalanceUsd = 80;
  reserveImpl = async () => ({
    reservedAmount: 1.2,
    reservationTransactionId: "reservation-1",
    reconcile: async () => null,
  });
});

describe("admitAppInferenceCacheOnly", () => {
  test("uses the Durable Object lease as the sole pre-dispatch WAL", async () => {
    const pending = deferred<Awaited<ReturnType<typeof reserveImpl>>>();
    reserveImpl = () => pending.promise;
    const background: Promise<unknown>[] = [];
    const admission = await admitAppInferenceCacheOnly(
      params({ waitUntil: (promise) => background.push(promise) }),
    );
    const leaseParams = acquireInferenceAdmissionLease.mock.calls.at(-1)?.[0] as
      | {
          requestId: string;
          estimatedCostUsd: number;
          recovery: unknown;
        }
      | undefined;
    if (!leaseParams) throw new Error("expected inference admission lease");

    expect(admission.mode).toBe("deferred_app_reservation");
    expect(admission.estimatedTotalCostUsd).toBeCloseTo(1.2);
    expect(leaseParams.estimatedCostUsd).toBeCloseTo(1.2);
    expect(leaseParams.recovery).toEqual({
      version: 1,
      kind: "app",
      organizationId: "org-1",
      requestId: "request-1",
      userId: "user-1",
      model: "model-1",
      provider: "provider-1",
      billingSource: "gateway",
      description: "test inference",
      metadata: { route: "test" },
      appId: "app-1",
      estimatedBaseCostUsd: 1,
      appPolicy: {
        name: "App",
        creatorUserId: "creator",
        monetizationEnabled: true,
        reviewStatus: null,
        platformOffsetAmount: null,
        purchaseSharePercentage: null,
        inferenceMarkupPercentage: "20",
      },
    });
    expect(gateReads).toBe(1);
    expect(background).toHaveLength(0);
    expect(reserveCalls).toBe(0);

    const settlement = admission.settle(0.4);
    await Promise.resolve();
    expect(reserveCalls).toBe(1);
    expect(
      reserveArgs.map(({ estimatedBaseCost, idempotencyKey }) => ({
        estimatedBaseCost,
        idempotencyKey,
      })),
    ).toEqual([
      {
        estimatedBaseCost: 1,
        idempotencyKey: "request-1",
      },
    ]);
    pending.resolve({
      reservedAmount: 1.2,
      reservationTransactionId: "reservation-1",
      reconcile: async () => null,
    });
    await settlement;
    expect(usageProjections).toEqual(["reservation-1"]);
  });

  test("settles through the deterministic estimate reservation and refreshes the hint", async () => {
    const reconciled: number[] = [];
    reserveImpl = async () => ({
      reservedAmount: 1.2,
      reservationTransactionId: "reservation-1",
      reconcile: async (actualCost) => {
        reconciled.push(actualCost);
        return null;
      },
    });
    const admission = await admitAppInferenceCacheOnly(params({ waitUntil: () => undefined }));
    expect(reserveCalls).toBe(0);

    expect(await admission.settle(0.4)).toBeNull();
    expect(reconciled).toEqual([0.4]);
    expect(hintWrites).toEqual([80]);
    expect(reserveCalls).toBe(1);
    expect(
      reserveArgs.map(({ estimatedBaseCost, idempotencyKey }) => ({
        estimatedBaseCost,
        idempotencyKey,
      })),
    ).toEqual([
      {
        estimatedBaseCost: 1,
        idempotencyKey: "request-1",
      },
    ]);
  });

  test("unknown provider cost conservatively settles the admitted estimate and wins races", async () => {
    const reconciled: number[] = [];
    reserveImpl = async () => ({
      reservedAmount: 1.2,
      reservationTransactionId: "reservation-unknown",
      reconcile: async (actualCost) => {
        reconciled.push(actualCost);
        return {
          reservedAmount: 1.2,
          actualCost: actualCost * 1.2,
          reservationTransactionId: "reservation-unknown",
          settlementTransactionIds: [],
          adjustmentType: "none",
        };
      },
    });
    const admission = await admitAppInferenceCacheOnly(params({ waitUntil: () => undefined }));

    const unknown = admission.settleUnknown();
    const laterActual = admission.settle(0);

    await expect(unknown).resolves.toMatchObject({ actualCost: 1.2 });
    await expect(laterActual).resolves.toEqual(await unknown);
    expect(reconciled).toEqual([1]);
    expect(settleInferenceAdmissionLease).toHaveBeenCalledTimes(1);
    expect(settleInferenceAdmissionLease.mock.calls[0]?.[1]).toBeCloseTo(1.2);
  });

  test("a keyed reconciliation rejection heals with the first actual cost", async () => {
    const reconciled: number[] = [];
    let attempt = 0;
    reserveImpl = async () => ({
      reservedAmount: 1.2,
      reservationTransactionId: "reservation-heal",
      reconcile: async (actualCost) => {
        reconciled.push(actualCost);
        attempt++;
        if (attempt === 1) throw new Error("settlement acknowledgement lost");
        return {
          reservedAmount: 1.2,
          actualCost,
          reservationTransactionId: "reservation-heal",
          settlementTransactionIds: [],
          adjustmentType: "refund",
        };
      },
    });
    const admission = await admitAppInferenceCacheOnly(params({ waitUntil: () => undefined }));

    await expect(admission.settle(0.4)).rejects.toThrow("settlement acknowledgement lost");
    await expect(admission.settle(9)).resolves.toMatchObject({ actualCost: 0.4 });
    expect(reconciled).toEqual([0.4, 0.4]);
    expect(reserveArgs.map((call) => call.estimatedBaseCost)).toEqual([1, 1]);
    expect(reserveArgs.map((call) => call.idempotencyKey)).toEqual(["request-1", "request-1"]);
    expect(refusalMarks).toEqual(["org-1"]);
    expect(refusalClears).toEqual(["org-1"]);
  });

  test("an unconfirmed post-settlement hint write retains refusal until cache repair", async () => {
    let reconcileCalls = 0;
    reserveImpl = async () => ({
      reservedAmount: 1.2,
      reservationTransactionId: "reservation-cache-repair",
      reconcile: async (actualCost) => {
        reconcileCalls++;
        return {
          reservedAmount: 1.2,
          actualCost,
          reservationTransactionId: "reservation-cache-repair",
          settlementTransactionIds: [],
          adjustmentType: "none",
        };
      },
    });
    hintWriteError = new Error("cache write unconfirmed");
    const admission = await admitAppInferenceCacheOnly(params({ waitUntil: () => undefined }));

    await expect(admission.settle(0.4)).rejects.toThrow("cache write unconfirmed");
    expect(refusalMarks).toContain("org-1");
    expect(refusalClears).toHaveLength(0);

    hintWriteError = null;
    await expect(admission.settle(9)).resolves.toMatchObject({ actualCost: 0.4 });
    expect(reconcileCalls).toBe(2);
    expect(reserveArgs.map((call) => call.estimatedBaseCost)).toEqual([1, 1]);
    expect(reserveArgs.map((call) => call.idempotencyKey)).toEqual(["request-1", "request-1"]);
    expect(refusalClears).toEqual(["org-1"]);
  });

  test("client key reuse cannot dedupe two server request dispatches", async () => {
    const firstAdmission = await admitAppInferenceCacheOnly(params({ waitUntil: () => undefined }));

    const secondAdmission = await admitAppInferenceCacheOnly({
      ...params({ waitUntil: () => undefined }),
      requestId: "request-2",
      idempotencyKey: "idem-1",
    });
    expect(reserveCalls).toBe(0);

    await firstAdmission.settle(0.5);
    await secondAdmission.settle(0.5);

    expect(reserveArgs.map((call) => call.idempotencyKey)).toEqual(["request-1", "request-2"]);
    expect(reserveArgs.map((call) => call.estimatedBaseCost)).toEqual([1, 1]);
  });

  test("cached insufficient balance rejects before reservation or model work", async () => {
    cachedBalanceUsd = 0.5;
    const background: Promise<unknown>[] = [];

    await expect(
      admitAppInferenceCacheOnly(params({ waitUntil: (promise) => background.push(promise) })),
    ).rejects.toMatchObject({
      name: "InsufficientCreditsError",
      required: 1.2,
      available: 0.5,
      reason: "cached_balance_gate",
    });
    expect(reserveCalls).toBe(0);
    expect(background).toHaveLength(0);
  });

  test("balance-cache warming propagates without starting reservation", async () => {
    const warming = new Error("warming");
    warming.name = "InferenceBalanceCacheWarmingError";
    gateError = warming;
    const background: Promise<unknown>[] = [];

    await expect(
      admitAppInferenceCacheOnly(params({ waitUntil: (promise) => background.push(promise) })),
    ).rejects.toBe(warming);
    expect(reserveCalls).toBe(0);
    expect(background).toHaveLength(1);
    await background[0];
  });

  test("reservation refusal never retries with a different actual-cost estimate", async () => {
    let attempt = 0;
    let creatorEarningsWrites = 0;
    reserveImpl = async ({ estimatedBaseCost }) => {
      attempt += 1;
      if (attempt === 1) {
        throw new TestInsufficientCreditsError(1.2, 0, "race");
      }
      creatorEarningsWrites += 1;
      return {
        reservedAmount: estimatedBaseCost * 1.2,
        reservationTransactionId: "fallback-reservation",
        reconcile: async (actualCost) => ({
          reservedAmount: actualCost * 1.2,
          actualCost,
          reservationTransactionId: "fallback-reservation",
          settlementTransactionIds: [],
          adjustmentType: "none",
        }),
      };
    };
    const admission = await admitAppInferenceCacheOnly(params({ waitUntil: () => undefined }));
    expect(reserveCalls).toBe(0);

    const first = admission.settle(0.5);
    const second = admission.settle(99);
    await expect(first).resolves.toMatchObject({
      reservedAmount: 0,
      actualCost: 0.6,
      adjustmentType: "uncollected_overage",
    });
    await expect(second).resolves.toEqual(await first);
    expect(reserveCalls).toBe(1);
    expect(reserveArgs.map((call) => call.estimatedBaseCost)).toEqual([1]);
    expect(reserveArgs.map((call) => call.idempotencyKey)).toEqual(["request-1"]);
    expect(creatorEarningsWrites).toBe(0);
    expect(invalidations).toBe(1);
    expect(refusalMarks).toEqual(["org-1"]);
    expect(refusalClears).toEqual([]);
  });

  test("reservation refusal with uncollectable actual cost reports zero collection and no earnings", async () => {
    let creatorEarningsWrites = 0;
    reserveImpl = async () => {
      creatorEarningsWrites += 0;
      throw new TestInsufficientCreditsError(1.2, 0, "race");
    };
    const admission = await admitAppInferenceCacheOnly(params({ waitUntil: () => undefined }));

    await expect(admission.settle(0.5)).resolves.toEqual({
      reservedAmount: 0,
      actualCost: 0.6,
      settlementTransactionIds: [],
      adjustmentType: "uncollected_overage",
    });
    expect(reserveCalls).toBe(1);
    expect(reserveArgs.map((call) => call.estimatedBaseCost)).toEqual([1]);
    expect(reserveArgs.map((call) => call.idempotencyKey)).toEqual(["request-1"]);
    expect(creatorEarningsWrites).toBe(0);
  });

  test("unexpected reservation failure remains observable without a second allocation", async () => {
    const failure = new Error("database unavailable");
    reserveImpl = async () => {
      throw failure;
    };
    const admission = await admitAppInferenceCacheOnly(params({ waitUntil: () => undefined }));
    expect(reserveCalls).toBe(0);

    const first = admission.settle(0.5);
    const second = admission.settle(99);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(reserveCalls).toBe(1);
  });

  test("app plus affiliate is rejected before cache or authoritative money work", async () => {
    const background: Promise<unknown>[] = [];
    await expect(
      admitAppInferenceCacheOnly({
        ...params({ waitUntil: (promise) => background.push(promise) }),
        affiliateCode: "PARTNER",
      }),
    ).rejects.toMatchObject({
      name: "InferenceAppAffiliateUnsupportedError",
      appId: "app-1",
    });
    expect(gateReads).toBe(0);
    expect(reserveCalls).toBe(0);
    expect(background).toHaveLength(0);
  });
});
