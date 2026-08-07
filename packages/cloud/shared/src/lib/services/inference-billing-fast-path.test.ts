/**
 * Unit tests for Tier-2 optimistic off-path inference billing (#9899).
 *
 * Uses the REAL CacheClient (MOCK_REDIS=1 in-memory adapter) so the durable
 * pending-charge backstop, atomic getAndDelete claim, and prefix-scan sweep are
 * exercised end-to-end. Only the credits + api-keys seams are mocked.
 */

process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// --- Controllable credits + api-keys seams ----------------------------------
interface DeductCall {
  organizationId: string;
  amount: number;
  source: unknown;
  idempotencyKey: string | undefined;
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
let freshBalanceUsd: number;
let freshBalanceCalls = 0;
const invalidateUserCalls: string[] = [];
let invalidateUserShouldReject = false;

mock.module("./credits", () => ({
  creditsService: {
    deductCredits: async (args: {
      organizationId: string;
      amount: number;
      metadata?: { source?: unknown; requestId?: string };
      stripePaymentIntentId?: string;
    }) => {
      deductCalls.push({
        organizationId: args.organizationId,
        amount: args.amount,
        source: args.metadata?.source,
        idempotencyKey: args.stripePaymentIntentId,
      });
      if (deductError) throw deductError;
      // Mirror production: a committed debit runs
      // `CacheInvalidation.onCreditMutation`, which DELETES the org-balance
      // gate hint before the settler's post-debit cache step runs. Modelling
      // this is what makes the "next turn is warm" assertions real — without
      // it the hint survives and the test cannot observe the 503 flap.
      if (deductResult.success) {
        const { CacheKeys: Keys } = await import("../cache/keys");
        const { cache: c } = await import("../cache/client");
        await c.del(Keys.inference.orgBalance(args.organizationId));
      }
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
    getOrganizationBalanceSnapshot: async () => {
      freshBalanceCalls++;
      return { balanceUsd: freshBalanceUsd, revision: "2" };
    },
  },
}));

mock.module("./api-keys", () => ({
  apiKeysService: {
    invalidateInferenceContextForUser: async (userId: string) => {
      invalidateUserCalls.push(userId);
      if (invalidateUserShouldReject) {
        throw new Error("iac eviction unavailable");
      }
    },
  },
}));

const {
  isOptimisticBillingEnabled,
  isOptimisticBackstopAvailable,
  resolveSafeBalanceThresholdUsd,
  isOptimisticEligible,
  isPendingInferenceCharge,
  getGateBalanceUsd,
  InferenceBalanceCacheWarmingError,
  writePendingInferenceCharge,
  createOptimisticDebitSettler,
  sweepStalePendingInferenceCharges,
} = await import("./inference-billing-fast-path");
const { cache } = await import("../cache/client");
const { CacheKeys } = await import("../cache/keys");
const { logger } = await import("../utils/logger");
const { invalidateOrgBalanceHint, readOrgBalanceHint, writeOrgBalanceHint } = await import(
  "./inference-auth-cache"
);
const { isOrgAdmissionRefused, markOrgAdmissionRefused } = await import(
  "./inference-billing-deferred"
);

// Mirror of the module-private sweep-lock key (kept as a literal so a rename is
// caught loudly by the lock test below).
const SWEEP_LOCK_KEY = "iac:sweep-lock:v1";

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
  deductResult = { success: true, newBalance: 100, transaction: { id: "debit-1" } };
  deductError = null;
  freshBalanceUsd = 50;
  freshBalanceCalls = 0;
  invalidateUserCalls.length = 0;
  invalidateUserShouldReject = false;
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
      v: 2,
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
    // Stale pre-IAC-v2 records must be rejected, not migrated (#17805 bumped
    // INFERENCE_AUTH_CONTEXT_VERSION 1 -> 2; the sweep drops unversioned strays).
    expect(isPendingInferenceCharge({ ...ok, v: 1 })).toBe(false);
    expect(isPendingInferenceCharge({ ...ok, v: 3 })).toBe(false);
    expect(isPendingInferenceCharge({ ...ok, estimatedCostUsd: Number.NaN })).toBe(false);
    expect(isPendingInferenceCharge(null)).toBe(false);
    expect(isPendingInferenceCharge({ requestId: "r" })).toBe(false);
  });
});

describe("getGateBalanceUsd", () => {
  test("hint hit returns hint, no fresh DB read", async () => {
    const org = uid("org");
    await writeOrgBalanceHint(org, 42, Date.now(), "1");
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
  test("stale hint is served immediately AND triggers a background revalidation", async () => {
    const org = uid("org");
    freshBalanceUsd = 77;
    // A hint older than the orgBalance freshness window (15s).
    await writeOrgBalanceHint(org, 42, Date.now() - 20_000, "1");
    const bal = await getGateBalanceUsd(org);
    expect(bal).toBe(42); // served the STALE value without blocking on a DB read
    // Revalidation runs off the hot path; let the background task settle.
    await new Promise((r) => setTimeout(r, 25));
    expect(freshBalanceCalls).toBe(1); // authoritative refresh happened in the background
    expect((await readOrgBalanceHint(org))?.balanceUsd).toBe(77); // hint now fresh
  });
  test("concurrent stale reads dedupe to a single revalidation", async () => {
    const org = uid("org");
    freshBalanceUsd = 88;
    await writeOrgBalanceHint(org, 42, Date.now() - 20_000, "1");
    const results = await Promise.all([
      getGateBalanceUsd(org),
      getGateBalanceUsd(org),
      getGateBalanceUsd(org),
    ]);
    expect(results).toEqual([42, 42, 42]); // all served the stale value
    await new Promise((r) => setTimeout(r, 25));
    expect(freshBalanceCalls).toBe(1); // in-flight guard collapsed 3 reads to 1 DB refresh
  });

  test("cache-only miss fails closed and hydrates under waitUntil", async () => {
    const org = uid("org");
    freshBalanceUsd = 27;
    markOrgAdmissionRefused(org);
    const background: Promise<unknown>[] = [];
    await expect(
      getGateBalanceUsd(org, {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).rejects.toBeInstanceOf(InferenceBalanceCacheWarmingError);
    expect(background).toHaveLength(1);
    await background[0];
    expect(freshBalanceCalls).toBe(1);
    expect((await readOrgBalanceHint(org))?.balanceUsd).toBe(27);
    expect(isOrgAdmissionRefused(org)).toBe(false);
  });

  test("stale hint returns immediately and revalidates off path", async () => {
    const org = uid("org");
    freshBalanceUsd = 19;
    await writeOrgBalanceHint(org, 31, Date.now() - 61_000, "1");
    const background: Promise<unknown>[] = [];
    expect(
      await getGateBalanceUsd(org, {
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).toBe(31);
    expect(background).toHaveLength(1);
    await background[0];
    expect((await readOrgBalanceHint(org))?.balanceUsd).toBe(19);
  });
});

describe("org balance cache confirmation", () => {
  test("an unconfirmed balance write rejects", async () => {
    const write = spyOn(cache, "setWithOutcome").mockResolvedValue({
      kind: "unavailable",
      backend: "memory",
    });
    try {
      await expect(writeOrgBalanceHint(uid("org"), 10, Date.now(), "1")).rejects.toThrow(
        "write was not confirmed",
      );
    } finally {
      write.mockRestore();
    }
  });

  test("an unconfirmed balance invalidation rejects", async () => {
    const del = spyOn(cache, "delConfirmed").mockResolvedValue(false);
    try {
      await expect(invalidateOrgBalanceHint(uid("org"))).rejects.toThrow(
        "invalidation was not confirmed",
      );
    } finally {
      del.mockRestore();
    }
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
    expect(res).toEqual({
      reservedAmount: 0.02,
      actualCost: 0.02,
      settlementTransactionIds: ["debit-1"],
      adjustmentType: "none",
    });
    expect(deductCalls).toHaveLength(1);
    expect(deductCalls[0].amount).toBe(0.02);
    expect(deductCalls[0].source).toBe("inline");
    expect(deductCalls[0].idempotencyKey).toBe(
      `inference-debit:${input.organizationId}:${input.requestId}`,
    );
    // Entry was claimed (deleted), so the sweep can never double-charge it.
    expect(await cache.get(CacheKeys.inference.pendingCharge(input.requestId))).toBeNull();
  });

  test("on debit success republishes the org-balance hint the credit mutation evicted", async () => {
    const input = chargeInput();
    deductResult = { success: true, newBalance: 7.5, transaction: { id: "debit-2" } };
    // Authoritative post-debit balance the republish must pick up.
    freshBalanceUsd = 7.5;
    await writeOrgBalanceHint(input.organizationId, 10, Date.now(), "1");
    await writePendingInferenceCharge(input, Date.now());
    await createOptimisticDebitSettler(input)(0.02);
    expect((await readOrgBalanceHint(input.organizationId))?.balanceUsd).toBe(7.5);
  });

  // REGRESSION (staging 2026-08-05): every settled turn left the gate hint
  // ABSENT, because the committed debit's `onCreditMutation` deletes it and the
  // old lower-only repair bails when no entry exists. On the Worker hot path a
  // missing hint is read `cacheOnly`, so the next turn fail-closed with a
  // user-visible 503 "Billing authorization is warming" — producing a strict
  // 200/503 alternation on a healthy, funded org.
  test("leaves a warm hint so the NEXT turn does not fail closed on a cacheOnly read", async () => {
    const input = chargeInput();
    deductResult = { success: true, newBalance: 4.25, transaction: { id: "debit-flap" } };
    freshBalanceUsd = 4.25;
    await writeOrgBalanceHint(input.organizationId, 9, Date.now(), "1");
    await writePendingInferenceCharge(input, Date.now());

    await createOptimisticDebitSettler(input)(0.02);

    // The settled turn must NOT leave the org unhinted.
    expect(await readOrgBalanceHint(input.organizationId)).not.toBeNull();
    // And the next turn's hot-path read must succeed instead of throwing the
    // cache-warming error the route surfaces as a 503.
    await expect(getGateBalanceUsd(input.organizationId, { cacheOnly: true })).resolves.toBe(4.25);
  });

  // Opposite direction: the republish must not resurrect a hint for an org the
  // settler deliberately forced off the fast path.
  test("a REFUSED debit still leaves the hint absent so the next turn slow-paths", async () => {
    const input = chargeInput();
    deductResult = {
      success: false,
      newBalance: 0,
      transaction: null,
      reason: "insufficient_balance",
    };
    await writeOrgBalanceHint(input.organizationId, 999, Date.now(), "1");
    await writePendingInferenceCharge(input, Date.now());

    await createOptimisticDebitSettler(input)(0.02);

    expect(await readOrgBalanceHint(input.organizationId)).toBeNull();
    await expect(
      getGateBalanceUsd(input.organizationId, { cacheOnly: true }),
    ).rejects.toBeInstanceOf(InferenceBalanceCacheWarmingError);
  });

  test("republished hint carries authoritative balance AND revision, not the stale pre-debit ones", async () => {
    const input = chargeInput();
    deductResult = { success: true, newBalance: 3, transaction: { id: "debit-rev" } };
    freshBalanceUsd = 3;
    // Stale entry: higher balance, older revision "1". The credits seam reports
    // revision "2" as authoritative.
    await writeOrgBalanceHint(input.organizationId, 42, Date.now(), "1");
    await writePendingInferenceCharge(input, Date.now());

    await createOptimisticDebitSettler(input)(0.02);

    const hint = await readOrgBalanceHint(input.organizationId);
    expect(hint?.balanceUsd).toBe(3);
    expect(hint?.balanceRevision).toBe("2");
  });

  test("on FAILED debit (insufficient) forces org off the fast path", async () => {
    const input = chargeInput();
    deductResult = {
      success: false,
      newBalance: 0,
      transaction: null,
      reason: "insufficient_balance",
    };
    await writeOrgBalanceHint(input.organizationId, 999, Date.now(), "1");
    await writePendingInferenceCharge(input, Date.now());
    await createOptimisticDebitSettler(input)(0.02);
    // Org-balance hint invalidated + user IAC invalidated → next request slow-paths.
    expect(await readOrgBalanceHint(input.organizationId)).toBeNull();
    expect(invalidateUserCalls).toContain(input.userId);
  });

  test("on FAILED debit contains a user IAC invalidation failure", async () => {
    const input = chargeInput();
    deductResult = {
      success: false,
      newBalance: 0,
      transaction: null,
      reason: "insufficient_balance",
    };
    invalidateUserShouldReject = true;
    await writeOrgBalanceHint(input.organizationId, 999, Date.now(), "1");
    await writePendingInferenceCharge(input, Date.now());

    await expect(createOptimisticDebitSettler(input)(0.02)).resolves.toMatchObject({
      adjustmentType: "uncollected_overage",
    });

    expect(await readOrgBalanceHint(input.organizationId)).toBeNull();
    expect(invalidateUserCalls).toContain(input.userId);
  });

  test("actualCost 0 claims the entry but charges nothing", async () => {
    const input = chargeInput();
    await writePendingInferenceCharge(input, Date.now());
    const res = await createOptimisticDebitSettler(input)(0);
    expect(res).toEqual({
      reservedAmount: 0,
      actualCost: 0,
      settlementTransactionIds: [],
      adjustmentType: "none",
    });
    expect(deductCalls).toHaveLength(0);
    expect(await cache.get(CacheKeys.inference.pendingCharge(input.requestId))).toBeNull();
  });

  test("second settle reuses the first result without a second charge", async () => {
    const input = chargeInput();
    await writePendingInferenceCharge(input, Date.now());
    const settle = createOptimisticDebitSettler(input);
    await settle(0.02);
    deductCalls = [];
    const res = await settle(0.02);
    expect(res).toMatchObject({
      reservedAmount: 0.02,
      actualCost: 0.02,
      adjustmentType: "none",
    });
    expect(deductCalls).toHaveLength(0);
  });

  test("a rejected debit is durably requeued and retries the first actual cost", async () => {
    const input = chargeInput({ estimatedCostUsd: 0.01 });
    await writePendingInferenceCharge(input, Date.now());
    deductError = new Error("debit acknowledgement lost");
    const settle = createOptimisticDebitSettler(input);

    await expect(settle(0.02)).rejects.toMatchObject({
      name: "InferenceDebitInfrastructureError",
      cause: deductError,
    });
    expect(
      (
        await cache.get<{ estimatedCostUsd: number }>(
          CacheKeys.inference.pendingCharge(input.requestId),
        )
      )?.estimatedCostUsd,
    ).toBe(0.02);

    deductError = null;
    await expect(settle(99)).resolves.toMatchObject({
      reservedAmount: 0.02,
      actualCost: 0.02,
      adjustmentType: "none",
    });
    expect(deductCalls.map((call) => call.amount)).toEqual([0.02, 0.02]);
  });

  test("a persisted debit from another organization is rejected and requeued", async () => {
    const input = chargeInput();
    await writePendingInferenceCharge(input, Date.now());
    deductResult = {
      success: true,
      newBalance: 7,
      transaction: {
        id: "foreign-debit",
        organization_id: "other-org",
        amount: "-0.02",
        metadata: { requestId: input.requestId },
      },
    };

    await expect(createOptimisticDebitSettler(input)(0.02)).rejects.toMatchObject({
      name: "InferenceDebitReplayMismatchError",
      organizationId: input.organizationId,
    });
    expect(await cache.get(CacheKeys.inference.pendingCharge(input.requestId))).not.toBeNull();
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

  test("a held single-flight lock makes the sweep a no-op (no overlapping claims)", async () => {
    const input = chargeInput({ estimatedCostUsd: 0.05 });
    await writePendingInferenceCharge(input, 1); // ancient -> would settle if unlocked
    // Simulate another sweep already holding the lock.
    await cache.setIfNotExists(SWEEP_LOCK_KEY, 1, 50_000);
    const stats = await sweepStalePendingInferenceCharges({ now: 10_000_000 });
    expect(stats.locked).toBe(true);
    expect(stats.settled).toBe(0);
    expect(deductCalls).toHaveLength(0);
    // Entry is untouched, so the next (unlocked) sweep still settles it.
    expect(await cache.get(CacheKeys.inference.pendingCharge(input.requestId))).not.toBeNull();
    await cache.del(SWEEP_LOCK_KEY);
  });

  test("logs sweep-lock release failure without failing the completed sweep", async () => {
    const originalDel = cache.del.bind(cache);
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const del = spyOn(cache, "del").mockImplementation(async (key: string) => {
      if (key === SWEEP_LOCK_KEY) {
        throw new Error("kv delete unavailable");
      }
      return originalDel(key);
    });

    try {
      const stats = await sweepStalePendingInferenceCharges({ now: 10_000_000 });
      expect(stats.locked).toBe(false);
      expect(
        warn.mock.calls.some(([message]) => String(message).includes("failed to release")),
      ).toBe(true);
    } finally {
      del.mockRestore();
      warn.mockRestore();
      await cache.del(SWEEP_LOCK_KEY);
    }
  });
});

describe("#9899 hardening: backstop durability, lower-only hint, claim atomicity", () => {
  test("writePendingInferenceCharge reports true when the backstop persists", async () => {
    const input = chargeInput();
    const ok = await writePendingInferenceCharge(input, Date.now());
    expect(ok).toBe(true);
    expect(await cache.get(CacheKeys.inference.pendingCharge(input.requestId))).not.toBeNull();
  });

  test("isOptimisticBackstopAvailable is true when the cache is up", () => {
    expect(isOptimisticBackstopAvailable()).toBe(true);
  });

  // The gate must never be raised above authoritative state by an out-of-order
  // debit (#9899 over-admit bound). The settler no longer trusts the debit's
  // own `newBalance` for this at all: the committed debit's `onCreditMutation`
  // evicts the hint, so the settler re-reads AUTHORITATIVE state and republishes
  // that. A transaction reporting a stale-high balance therefore cannot raise
  // the gate, because its reported number is never written.
  test("a stale-high debit report never raises the gate; authoritative state wins", async () => {
    const input = chargeInput();
    await writeOrgBalanceHint(input.organizationId, 10, Date.now(), "1");
    // Out-of-order: the debit claims 20, but the database says 6.
    deductResult = { success: true, newBalance: 20, transaction: { id: "debit-high" } };
    freshBalanceUsd = 6;
    await writePendingInferenceCharge(input, Date.now());
    await createOptimisticDebitSettler(input)(0.01);
    // The stale-high 20 is never published; the authoritative 6 is.
    expect((await readOrgBalanceHint(input.organizationId))?.balanceUsd).toBe(6);

    // A subsequent debit lowers it further, still from authoritative state.
    const input2 = chargeInput({ organizationId: input.organizationId });
    deductResult = { success: true, newBalance: 4, transaction: { id: "debit-low" } };
    freshBalanceUsd = 4;
    await writePendingInferenceCharge(input2, Date.now());
    await createOptimisticDebitSettler(input2)(0.01);
    expect((await readOrgBalanceHint(input.organizationId))?.balanceUsd).toBe(4);
  });

  // Clamp direction: if a concurrent debit published a STRICTER gate between
  // this settler's authoritative read and its write, that stricter value must
  // survive — while the entry still stays PRESENT (never absent).
  test("republish is min-clamped against a concurrent stricter gate", async () => {
    const { republishOrgBalanceHint } = await import("./inference-auth-cache");
    const orgId = uid("org");
    await writeOrgBalanceHint(orgId, 2, Date.now(), "5");
    // An authoritative snapshot that is HIGHER than what a concurrent debit
    // already published must not raise the gate back up.
    await republishOrgBalanceHint(orgId, 9, Date.now(), "6");
    const hint = await readOrgBalanceHint(orgId);
    expect(hint?.balanceUsd).toBe(2);
    expect(hint).not.toBeNull();
  });

  test("two concurrent inline claims of one request charge exactly once (atomic getAndDelete)", async () => {
    const input = chargeInput();
    await writePendingInferenceCharge(input, Date.now());
    const settle = createOptimisticDebitSettler(input);
    await Promise.all([settle(0.02), settle(0.02)]);
    expect(deductCalls).toHaveLength(1); // only one claim wins; no double-bill
  });

  test("concurrent inline settle + cron sweep on one request charge at most once", async () => {
    const input = chargeInput({ estimatedCostUsd: 0.05 });
    await writePendingInferenceCharge(input, 1); // ancient -> sweep-eligible
    await Promise.all([
      createOptimisticDebitSettler(input)(0.02),
      sweepStalePendingInferenceCharges({ now: 10_000_000 }),
    ]);
    expect(deductCalls.length).toBeLessThanOrEqual(1);
  });
});
