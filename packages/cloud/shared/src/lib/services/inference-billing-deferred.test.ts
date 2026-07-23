/**
 * Unit tests for Tier-3 deferred billing admission (#9899).
 *
 * Uses the REAL CacheClient (MOCK_REDIS=1 in-memory adapter) so the org-balance
 * hint invalidation on a refused admission is exercised for real, and the REAL
 * `debitInferenceCost` fallback (only the credits + api-keys seams are mocked,
 * same pattern as inference-billing-fast-path.test.ts).
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface DeductCall {
  organizationId: string;
  amount: number;
  source: unknown;
}
let deductCalls: DeductCall[] = [];
let deductResult:
  | {
      success: true;
      newBalance: number;
      transaction: {
        id: string;
        organization_id?: string;
        amount?: string;
        metadata?: Record<string, unknown>;
      };
    }
  | {
      success: false;
      newBalance: number;
      transaction: null;
      reason: "insufficient_balance";
    };
let deductError: Error | null = null;

mock.module("./credits", () => ({
  creditsService: {
    deductCredits: async (args: {
      organizationId: string;
      amount: number;
      metadata?: { source?: unknown; requestId?: string };
    }) => {
      deductCalls.push({
        organizationId: args.organizationId,
        amount: args.amount,
        source: args.metadata?.source,
      });
      if (deductError) throw deductError;
      if (deductResult.success) {
        return {
          ...deductResult,
          transaction: {
            organization_id: args.organizationId,
            amount: String(-args.amount),
            metadata: { requestId: args.metadata?.requestId },
            ...deductResult.transaction,
          },
        };
      }
      return deductResult;
    },
    getOrganizationBalanceSnapshot: async () => ({
      balanceUsd: 100,
      revision: "2",
    }),
  },
}));

mock.module("./api-keys", () => ({
  apiKeysService: {
    invalidateInferenceContextForUser: async () => {},
  },
}));

const {
  createDeferredAdmissionSettler,
  isDeferredAdmissionEnabled,
  isOrgAdmissionRefused,
  markOrgAdmissionRefused,
  __clearDeferredAdmissionState,
} = await import("./inference-billing-deferred");
const { readOrgBalanceHint, writeOrgBalanceHint } = await import("./inference-auth-cache");

let n = 0;
const uid = (p: string) => `${p}-${++n}`;

function debitCtx(orgId: string) {
  return {
    requestId: uid("req"),
    organizationId: orgId,
    userId: uid("user"),
    model: "gpt-oss-120b",
    provider: "cerebras",
    billingSource: "gateway",
  };
}

describe("isDeferredAdmissionEnabled", () => {
  test("only an exact 'true' enables it (default-safe)", () => {
    expect(isDeferredAdmissionEnabled({})).toBe(false);
    expect(isDeferredAdmissionEnabled({ INFERENCE_DEFERRED_ADMISSION: "" })).toBe(false);
    expect(isDeferredAdmissionEnabled({ INFERENCE_DEFERRED_ADMISSION: "1" })).toBe(false);
    expect(isDeferredAdmissionEnabled({ INFERENCE_DEFERRED_ADMISSION: "TRUE" })).toBe(false);
    expect(isDeferredAdmissionEnabled({ INFERENCE_DEFERRED_ADMISSION: "true" })).toBe(true);
    expect(isDeferredAdmissionEnabled({ INFERENCE_DEFERRED_ADMISSION: " true " })).toBe(true);
  });
});

describe("refusal blocklist", () => {
  beforeEach(() => {
    __clearDeferredAdmissionState();
  });

  test("marked org is refused; unmarked org is not; clear resets", () => {
    const org = uid("org");
    expect(isOrgAdmissionRefused(org)).toBe(false);
    markOrgAdmissionRefused(org);
    expect(isOrgAdmissionRefused(org)).toBe(true);
    expect(isOrgAdmissionRefused(uid("other-org"))).toBe(false);
    __clearDeferredAdmissionState();
    expect(isOrgAdmissionRefused(org)).toBe(false);
  });
});

describe("createDeferredAdmissionSettler", () => {
  beforeEach(() => {
    __clearDeferredAdmissionState();
    deductCalls = [];
    deductResult = { success: true, newBalance: 90, transaction: { id: "debit-1" } };
    deductError = null;
  });

  test("admitted → delegates to the normal settler with the actual cost; no fallback debit", async () => {
    const ctx = debitCtx(uid("org"));
    const onAdmittedCalls: number[] = [];
    const settle = createDeferredAdmissionSettler({
      admission: Promise.resolve({ admitted: true }),
      onAdmitted: async (cost) => {
        onAdmittedCalls.push(cost);
        return null;
      },
      fallback: ctx,
    });

    await settle(0.42);

    expect(onAdmittedCalls).toEqual([0.42]);
    expect(deductCalls).toEqual([]);
    expect(isOrgAdmissionRefused(ctx.organizationId)).toBe(false);
  });

  test("admitted settlement rejection retries with the first actual cost", async () => {
    const ctx = debitCtx(uid("org"));
    const settledCosts: number[] = [];
    let attempt = 0;
    const settle = createDeferredAdmissionSettler({
      admission: Promise.resolve({ admitted: true }),
      onAdmitted: async (actualCostUsd) => {
        settledCosts.push(actualCostUsd);
        attempt++;
        if (attempt === 1) throw new Error("reconcile acknowledgement lost");
        return {
          reservedAmount: actualCostUsd,
          actualCost: actualCostUsd,
          settlementTransactionIds: ["settled"],
          adjustmentType: "none",
        };
      },
      fallback: ctx,
    });

    await expect(settle(0.42)).rejects.toThrow("reconcile acknowledgement lost");
    await expect(settle(9)).resolves.toMatchObject({ actualCost: 0.42 });
    expect(settledCosts).toEqual([0.42, 0.42]);
    expect(deductCalls).toHaveLength(0);
  });

  test("refused → charges the actual cost directly, marks the org refused, drops the balance hint", async () => {
    const ctx = debitCtx(uid("org"));
    // Seed a warm gate hint so the invalidation is observable.
    await writeOrgBalanceHint(ctx.organizationId, 100, Date.now(), "1");
    expect(await readOrgBalanceHint(ctx.organizationId)).not.toBeNull();

    const onAdmittedCalls: number[] = [];
    const settle = createDeferredAdmissionSettler({
      admission: Promise.resolve({ admitted: false }),
      onAdmitted: async (cost) => {
        onAdmittedCalls.push(cost);
        return null;
      },
      fallback: ctx,
    });

    const reconciliation = await settle(0.42);

    expect(onAdmittedCalls).toEqual([]);
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0]?.organizationId).toBe(ctx.organizationId);
    expect(deductCalls[0]?.amount).toBe(0.42);
    expect(deductCalls[0]?.source).toBe("deferred");
    expect(isOrgAdmissionRefused(ctx.organizationId)).toBe(true);
    expect(reconciliation).toEqual({
      reservedAmount: 0.42,
      actualCost: 0.42,
      settlementTransactionIds: ["debit-1"],
      adjustmentType: "none",
    });
    // The stale pre-forward hint (100) was dropped; the successful fallback
    // debit then re-seeded it with the fresh post-debit balance (lower-only).
    expect((await readOrgBalanceHint(ctx.organizationId))?.balanceUsd).toBe(90);
  });

  test("refused with settle(0) (error/abort path) → no debit, still refused + hint dropped", async () => {
    const ctx = debitCtx(uid("org"));
    await writeOrgBalanceHint(ctx.organizationId, 100, Date.now(), "1");
    const settle = createDeferredAdmissionSettler({
      admission: Promise.resolve({ admitted: false }),
      onAdmitted: async () => null,
      fallback: ctx,
    });

    const reconciliation = await settle(0);

    expect(deductCalls).toEqual([]);
    expect(isOrgAdmissionRefused(ctx.organizationId)).toBe(true);
    expect(reconciliation).toEqual({
      reservedAmount: 0,
      actualCost: 0,
      settlementTransactionIds: [],
      adjustmentType: "none",
    });
    // No debit ran, so nothing re-seeded the hint: it stays dropped.
    expect(await readOrgBalanceHint(ctx.organizationId)).toBeNull();
  });

  test("first-call-wins: a repeat settle (route double-invoke on the error path) neither re-debits nor re-settles", async () => {
    const ctx = debitCtx(uid("org"));
    const onAdmittedCalls: number[] = [];
    const settle = createDeferredAdmissionSettler({
      admission: Promise.resolve({ admitted: false }),
      onAdmitted: async (cost) => {
        onAdmittedCalls.push(cost);
        return null;
      },
      fallback: ctx,
    });

    await settle(0.42);
    await settle(0); // the outer catch's second settle
    await settle(0.42);

    expect(onAdmittedCalls).toEqual([]);
    expect(deductCalls).toHaveLength(1);
  });

  test("refused debit that the DB refuses (would overdraw) stays fail-closed: recorded uncollected, org still refused", async () => {
    deductResult = {
      success: false,
      newBalance: 0,
      transaction: null,
      reason: "insufficient_balance",
    };
    const ctx = debitCtx(uid("org"));
    const settle = createDeferredAdmissionSettler({
      admission: Promise.resolve({ admitted: false }),
      onAdmitted: async () => null,
      fallback: ctx,
    });

    const reconciliation = await settle(1.23);

    expect(deductCalls).toHaveLength(1);
    expect(isOrgAdmissionRefused(ctx.organizationId)).toBe(true);
    expect(reconciliation).toEqual({
      reservedAmount: 0,
      actualCost: 1.23,
      settlementTransactionIds: [],
      adjustmentType: "uncollected_overage",
    });
  });

  test("refused debit infrastructure failure retries the deterministic first cost", async () => {
    deductError = new Error("database unavailable");
    const ctx = debitCtx(uid("org"));
    const settle = createDeferredAdmissionSettler({
      admission: Promise.resolve({ admitted: false }),
      onAdmitted: async () => null,
      fallback: ctx,
    });

    await expect(settle(1.23)).rejects.toMatchObject({
      name: "InferenceDebitInfrastructureError",
      cause: deductError,
    });
    deductError = null;
    deductResult = {
      success: true,
      newBalance: 8.77,
      transaction: { id: "debit-retry" },
    };
    await expect(settle(99)).resolves.toMatchObject({
      reservedAmount: 1.23,
      actualCost: 1.23,
      adjustmentType: "none",
    });
    expect(deductCalls).toHaveLength(2);
    expect(deductCalls.map((call) => call.amount)).toEqual([1.23, 1.23]);
  });
});
