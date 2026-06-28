/**
 * Unit tests for Tier-2 optimistic off-path inference billing (#9899).
 *
 * Uses the REAL CacheClient (MOCK_REDIS=1 in-memory adapter) so the durable
 * pending-charge backstop, atomic getAndDelete claim, and prefix-scan sweep are
 * exercised end-to-end. Only the credits + api-keys seams are mocked.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// --- Controllable credits + api-keys seams ----------------------------------
interface DeductCall {
  organizationId: string;
  amount: number;
  source: unknown;
}
let deductCalls: DeductCall[] = [];
let deductResult: { success: true; newBalance: number } | { success: false; reason: string };
let freshBalanceUsd: number;
let freshBalanceCalls = 0;
const invalidateUserCalls: string[] = [];

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
    getOrganizationBalanceUsd: async () => {
      freshBalanceCalls++;
      return freshBalanceUsd;
    },
  },
}));

mock.module("./api-keys", () => ({
  apiKeysService: {
    invalidateInferenceContextForUser: async (userId: string) => {
      invalidateUserCalls.push(userId);
    },
  },
}));

const {
  isOptimisticBillingEnabled,
  resolveSafeBalanceThresholdUsd,
  isOptimisticEligible,
  isPendingInferenceCharge,
  getGateBalanceUsd,
  writePendingInferenceCharge,
  createOptimisticDebitSettler,
  sweepStalePendingInferenceCharges,
} = await import("./inference-billing-fast-path");
const { cache } = await import("../cache/client");
const { CacheKeys } = await import("../cache/keys");
const { readOrgBalanceHint, writeOrgBalanceHint } = await import("./inference-auth-cache");

let n = 0;
const uid = (p: string) => `${p}-${++n}`;

function chargeInput(over: Partial<Record<string, unknown>> = {}) {
  return {
    requestId: uid("req"),
    organizationId: uid("org"),
    userId: uid("user"),
    apiKeyId: uid("key"),
    model: "llama-3.3-70b",
    provider: "cerebras",
    billingSource: "org",
    estimatedCostUsd: 0.01,
    ...over,
  } as {
    requestId: string;
    organizationId: string;
    userId: string;
    apiKeyId: string | null;
    model: string;
    provider: string;
    billingSource: string;
    estimatedCostUsd: number;
  };
}

beforeEach(async () => {
  deductCalls = [];
  deductResult = { success: true, newBalance: 100 };
  freshBalanceUsd = 50;
  freshBalanceCalls = 0;
  invalidateUserCalls.length = 0;
  // Drop any pending entries left by a prior test.
  for (const key of await cache.scanByPrefix(CacheKeys.inference.pendingChargePrefix())) {
    await cache.del(key);
  }
});

afterEach(() => {
  mock.restore();
});

describe("isOptimisticBillingEnabled", () => {
  test("default OFF; ON only for exact 'true'", () => {
    expect(isOptimisticBillingEnabled({})).toBe(false);
    expect(isOptimisticBillingEnabled({ INFERENCE_OPTIMISTIC_BILLING: "true" })).toBe(true);
    expect(isOptimisticBillingEnabled({ INFERENCE_OPTIMISTIC_BILLING: " true " })).toBe(true);
    expect(isOptimisticBillingEnabled({ INFERENCE_OPTIMISTIC_BILLING: "1" })).toBe(false);
  });
});

describe("resolveSafeBalanceThresholdUsd (fail SAFE = +Inf)", () => {
  test("unset / blank / non-finite / non-positive -> +Infinity", () => {
    expect(resolveSafeBalanceThresholdUsd({})).toBe(Number.POSITIVE_INFINITY);
    expect(resolveSafeBalanceThresholdUsd({ SAFE_BALANCE_THRESHOLD: "" })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(resolveSafeBalanceThresholdUsd({ SAFE_BALANCE_THRESHOLD: "abc" })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(resolveSafeBalanceThresholdUsd({ SAFE_BALANCE_THRESHOLD: "0" })).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(resolveSafeBalanceThresholdUsd({ SAFE_BALANCE_THRESHOLD: "-5" })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
  test("valid positive parses", () => {
    expect(resolveSafeBalanceThresholdUsd({ SAFE_BALANCE_THRESHOLD: "10" })).toBe(10);
    expect(resolveSafeBalanceThresholdUsd({ SAFE_BALANCE_THRESHOLD: "2.5" })).toBe(2.5);
  });
});

describe("isOptimisticEligible", () => {
  const base = {
    enabled: true,
    useAppCredits: false,
    balanceUsd: 100,
    thresholdUsd: 10,
    estimatedCostUsd: 0.01,
  };
  test("eligible when balance clears threshold and est cost", () => {
    expect(isOptimisticEligible(base)).toBe(true);
  });
  test("not eligible when disabled", () => {
    expect(isOptimisticEligible({ ...base, enabled: false })).toBe(false);
  });
  test("not eligible for app-credits", () => {
    expect(isOptimisticEligible({ ...base, useAppCredits: true })).toBe(false);
  });
  test("not eligible when threshold is +Inf (misconfig fail-safe)", () => {
    expect(isOptimisticEligible({ ...base, thresholdUsd: Number.POSITIVE_INFINITY })).toBe(false);
  });
  test("not eligible when balance does not clear threshold", () => {
    expect(isOptimisticEligible({ ...base, balanceUsd: 5 })).toBe(false);
  });
  test("not eligible when balance does not clear est cost (tiny balance, huge call)", () => {
    expect(
      isOptimisticEligible({ ...base, balanceUsd: 11, thresholdUsd: 10, estimatedCostUsd: 20 }),
    ).toBe(false);
  });
});

describe("isPendingInferenceCharge shape guard", () => {
  test("accepts a full record, rejects partial / wrong version", () => {
    const ok = {
      v: 1,
      requestId: "r",
      organizationId: "o",
      userId: "u",
      apiKeyId: "k",
      model: "m",
      provider: "p",
      billingSource: "org",
      estimatedCostUsd: 0.01,
      enqueuedAt: 1,
    };
    expect(isPendingInferenceCharge(ok)).toBe(true);
    expect(isPendingInferenceCharge({ ...ok, v: 2 })).toBe(false);
    expect(isPendingInferenceCharge({ ...ok, estimatedCostUsd: Number.NaN })).toBe(false);
    expect(isPendingInferenceCharge(null)).toBe(false);
    expect(isPendingInferenceCharge({ requestId: "r" })).toBe(false);
  });
});

describe("getGateBalanceUsd", () => {
  test("hint hit returns hint, no fresh DB read", async () => {
    const org = uid("org");
    await writeOrgBalanceHint(org, 42, Date.now());
    const bal = await getGateBalanceUsd(org);
    expect(bal).toBe(42);
    expect(freshBalanceCalls).toBe(0);
  });
  test("miss reads fresh, writes hint, second call served from hint", async () => {
    const org = uid("org");
    freshBalanceUsd = 33;
    const bal = await getGateBalanceUsd(org);
    expect(bal).toBe(33);
    expect(freshBalanceCalls).toBe(1);
    const again = await getGateBalanceUsd(org);
    expect(again).toBe(33);
    expect(freshBalanceCalls).toBe(1); // hint served, no 2nd DB read
    expect((await readOrgBalanceHint(org))?.balanceUsd).toBe(33);
  });
});

describe("writePendingInferenceCharge + durable backstop", () => {
  test("writes a readable, shape-valid pending entry", async () => {
    const input = chargeInput();
    await writePendingInferenceCharge(input, 1000);
    const read = await cache.get(CacheKeys.inference.pendingCharge(input.requestId));
    expect(isPendingInferenceCharge(read)).toBe(true);
    expect((read as { enqueuedAt: number }).enqueuedAt).toBe(1000);
  });
});

describe("createOptimisticDebitSettler", () => {
  test("claims the pending entry and debits the ACTUAL cost", async () => {
    const input = chargeInput();
    await writePendingInferenceCharge(input, Date.now());
    const settle = createOptimisticDebitSettler(input);
    const res = await settle(0.02);
    expect(res).toBeNull();
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0].amount).toBe(0.02);
    expect(deductCalls[0].source).toBe("inline");
    // Entry was claimed (deleted), so the sweep can never double-charge it.
    expect(await cache.get(CacheKeys.inference.pendingCharge(input.requestId))).toBeNull();
  });

  test("on debit success refreshes the org-balance hint", async () => {
    const input = chargeInput();
    deductResult = { success: true, newBalance: 7.5 };
    await writePendingInferenceCharge(input, Date.now());
    await createOptimisticDebitSettler(input)(0.02);
    expect((await readOrgBalanceHint(input.organizationId))?.balanceUsd).toBe(7.5);
  });

  test("on FAILED debit (insufficient) forces org off the fast path", async () => {
    const input = chargeInput();
    deductResult = { success: false, reason: "insufficient_balance" };
    await writeOrgBalanceHint(input.organizationId, 999, Date.now());
    await writePendingInferenceCharge(input, Date.now());
    await createOptimisticDebitSettler(input)(0.02);
    // Org-balance hint invalidated + user IAC invalidated → next request slow-paths.
    expect(await readOrgBalanceHint(input.organizationId)).toBeNull();
    expect(invalidateUserCalls).toContain(input.userId);
  });

  test("actualCost 0 claims the entry but charges nothing", async () => {
    const input = chargeInput();
    await writePendingInferenceCharge(input, Date.now());
    const res = await createOptimisticDebitSettler(input)(0);
    expect(res).toBeNull();
    expect(deductCalls).toHaveLength(0);
    expect(await cache.get(CacheKeys.inference.pendingCharge(input.requestId))).toBeNull();
  });

  test("second settle of an already-claimed request is a no-op (no double charge)", async () => {
    const input = chargeInput();
    await writePendingInferenceCharge(input, Date.now());
    const settle = createOptimisticDebitSettler(input);
    await settle(0.02);
    deductCalls = [];
    const res = await settle(0.02);
    expect(res).toBeNull();
    expect(deductCalls).toHaveLength(0);
  });
});

describe("sweepStalePendingInferenceCharges", () => {
  test("settles stragglers older than grace via the ESTIMATE", async () => {
    const input = chargeInput({ estimatedCostUsd: 0.05 });
    const now = 10_000_000;
    await writePendingInferenceCharge(input, now - 25 * 60 * 1000); // older than 20m grace
    const stats = await sweepStalePendingInferenceCharges({ now });
    expect(stats.settled).toBe(1);
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0].amount).toBe(0.05);
    expect(deductCalls[0].source).toBe("backstop");
    expect(await cache.get(CacheKeys.inference.pendingCharge(input.requestId))).toBeNull();
  });

  test("skips young entries still in flight", async () => {
    const input = chargeInput();
    const now = 10_000_000;
    await writePendingInferenceCharge(input, now - 60 * 1000); // 1 min old < grace
    const stats = await sweepStalePendingInferenceCharges({ now });
    expect(stats.skippedYoung).toBe(1);
    expect(stats.settled).toBe(0);
    expect(deductCalls).toHaveLength(0);
    expect(await cache.get(CacheKeys.inference.pendingCharge(input.requestId))).not.toBeNull();
  });

  test("drops malformed entries under the prefix without charging", async () => {
    const badId = uid("bad");
    await cache.set(CacheKeys.inference.pendingCharge(badId), { garbage: true }, 1800);
    const stats = await sweepStalePendingInferenceCharges({ now: 10_000_000 });
    expect(stats.uncollectedOrStale).toBeGreaterThanOrEqual(1);
    expect(deductCalls).toHaveLength(0);
    expect(await cache.get(CacheKeys.inference.pendingCharge(badId))).toBeNull();
  });

  test("does not double-charge an entry the inline settler already claimed", async () => {
    const input = chargeInput();
    await writePendingInferenceCharge(input, 1); // ancient
    // Inline settle claims + charges actual first.
    await createOptimisticDebitSettler(input)(0.02);
    deductCalls = [];
    const stats = await sweepStalePendingInferenceCharges({ now: 10_000_000 });
    expect(stats.settled).toBe(0);
    expect(deductCalls).toHaveLength(0); // nothing left to sweep
  });
});
