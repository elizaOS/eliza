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
let deductResult: { success: true; newBalance: number } | { success: false; reason: string };

mock.module("./credits", () => ({
  creditsService: {
    deductCredits: async (args: {
      organizationId: string;
      amount: number;
      metadata?: { source?: unknown };
    }) => {
      deductCalls.push({
        organizationId: args.organizationId,
        amount: args.amount,
        source: args.metadata?.source,
      });
      return deductResult;
    },
    getOrganizationBalanceUsd: async () => 100,
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
    deductResult = { success: true, newBalance: 90 };
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

  test("refused → charges the actual cost directly, marks the org refused, drops the balance hint", async () => {
    const ctx = debitCtx(uid("org"));
    // Seed a warm gate hint so the invalidation is observable.
    await writeOrgBalanceHint(ctx.organizationId, 100, Date.now());
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

    await settle(0.42);

    expect(onAdmittedCalls).toEqual([]);
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0]?.organizationId).toBe(ctx.organizationId);
    expect(deductCalls[0]?.amount).toBe(0.42);
    expect(deductCalls[0]?.source).toBe("deferred");
    expect(isOrgAdmissionRefused(ctx.organizationId)).toBe(true);
    // The stale pre-forward hint (100) was dropped; the successful fallback
    // debit then re-seeded it with the fresh post-debit balance (lower-only).
    expect((await readOrgBalanceHint(ctx.organizationId))?.balanceUsd).toBe(90);
  });

  test("refused with settle(0) (error/abort path) → no debit, still refused + hint dropped", async () => {
    const ctx = debitCtx(uid("org"));
    await writeOrgBalanceHint(ctx.organizationId, 100, Date.now());
    const settle = createDeferredAdmissionSettler({
      admission: Promise.resolve({ admitted: false }),
      onAdmitted: async () => null,
      fallback: ctx,
    });

    await settle(0);

    expect(deductCalls).toEqual([]);
    expect(isOrgAdmissionRefused(ctx.organizationId)).toBe(true);
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
    deductResult = { success: false, reason: "insufficient balance" };
    const ctx = debitCtx(uid("org"));
    const settle = createDeferredAdmissionSettler({
      admission: Promise.resolve({ admitted: false }),
      onAdmitted: async () => null,
      fallback: ctx,
    });

    // Never throws — debitInferenceCost contains the failure.
    await settle(1.23);

    expect(deductCalls).toHaveLength(1);
    expect(isOrgAdmissionRefused(ctx.organizationId)).toBe(true);
  });
});
