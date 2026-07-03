/**
 * Route-level regression tests for the Tier-2 optimistic-billing DECISION in
 * POST /api/v1/embeddings (#9899 / #10106 — the embeddings recall hot path).
 *
 * The service layer (eligibility math, exactly-once settle, sweep) is covered by
 * `inference-billing-fast-path.test.ts`. What was NOT covered is the embeddings
 * ROUTE's orchestration of those functions:
 *
 *   gate (org && flag && backstop-writable) → REAL isOptimisticEligible → write
 *   the durable backstop → only on a durable write take the optimistic path;
 *   otherwise fall back to the synchronous credit reserve.
 *
 * These drive the REAL embeddings route through that decision with the REAL
 * `isOptimisticEligible`; only the env-gates, the gate-balance read, the backstop
 * write, the optimistic settler factory, `reserveCredits`, and the embedder are
 * mocked at the module boundary so we can prove which path the route chose.
 *
 * Invariants pinned (each with a POSITIVE assertion so an early bail can't make a
 * negative-only test pass):
 *   1. Eligible org → optimistic path: backstop written, synchronous reserve
 *      SKIPPED, optimistic settler wired.
 *   2. The backstop records the REAL input-token cost estimate (NOT 0) so a
 *      DROPPED settle is recoverable by the cron sweep (#10106 leak guard).
 *   3. Balance below SAFE_BALANCE_THRESHOLD → synchronous reserve (no backstop).
 *   4. Backstop not writable (cache down) → synchronous reserve.
 *   5. Flag OFF → synchronous reserve (default-safe).
 *   6. Non-durable backstop write → fall back to synchronous reserve (settler
 *      NOT wired) — never free inference.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
import * as pricingActual from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as inferenceAuthActual from "@/lib/services/inference-auth-context";
import * as fastPathActual from "@/lib/services/inference-billing-fast-path";
import * as ledgerActual from "@/lib/services/inference-billing-ledger";
import * as usageActual from "@/lib/services/usage";

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const EMBEDDING = [0.0125, -0.5, 0.333333];
const CLIENT_REQUEST_ID = "req-emb-optimistic";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// The fixed total the mocked calculateCost returns — what the backstop must
// record (proving the route no longer writes estimatedCostUsd: 0).
const BACKSTOP_COST = 0.0123;

// --- per-test knobs the mocks read by reference -----------------------------
let billingEnabled = true;
let backstopAvailable = true;
let gateBalanceUsd = 100;
let thresholdUsd = 5;
let backstopPersists = true;
let billingLedger = "kv"; // anything but "db" → the KV backstop branch

// --- spies on the two terminal billing paths --------------------------------
const writePendingInferenceCharge = mock(
  (
    _charge: { requestId: string; estimatedCostUsd: number },
    _now: number,
  ): Promise<boolean> => Promise.resolve(backstopPersists),
);
const reserveCredits = mock(async () => ({
  reservedAmount: 0,
  reconcile: async () => undefined,
}));
const createOptimisticDebitSettler = mock(() => async () => undefined);

// Auth: resolve straight to an authorized org user via the hot-path resolver.
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthActual,
  resolveInferenceAuthContext: async () => ({
    kind: "authorized",
    ctx: { userId: USER, orgId: ORG, apiKeyId: API_KEY_ID },
  }),
}));

// Rate limiting is not under test — make the org gate a no-op (no Redis).
mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit: async () => null,
}));

// Provider config: pretend an embedding provider is configured; the model object
// is unused because the embed call is stubbed.
mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  hasTextEmbeddingProviderConfigured: () => true,
  getTextEmbeddingModel: () => ({}) as never,
  resolveEmbeddingProviderSource: () => "openai",
}));

// Cost: the optimistic backstop now records the real input-token estimate. A
// fixed total lets us assert the pending charge carries it (not 0).
mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost: async () => ({
    totalCost: BACKSTOP_COST,
    inputCost: BACKSTOP_COST,
    outputCost: 0,
  }),
}));

// Component under test: the ROUTE's orchestration + the REAL isOptimisticEligible
// (spread). Env-gates, the balance read, the backstop write and the optimistic
// settler factory are controlled/spied.
mock.module("@/lib/services/inference-billing-fast-path", () => ({
  ...fastPathActual,
  isOptimisticBillingEnabled: () => billingEnabled,
  isOptimisticBackstopAvailable: () => backstopAvailable,
  getGateBalanceUsd: async () => gateBalanceUsd,
  resolveSafeBalanceThresholdUsd: () => thresholdUsd,
  writePendingInferenceCharge,
  createOptimisticDebitSettler,
}));

// DB-ledger optimistic branch (#12017): the ledger selector is a knob and the
// admission/settler are spied so the tests can prove which branch admitted.
const admitInferenceChargeViaLedger = mock(
  async () => ({ admitted: true }) as never,
);
const createLedgerDebitSettler = mock(() => async () => undefined);
mock.module("@/lib/services/inference-billing-ledger", () => ({
  ...ledgerActual,
  resolveInferenceBillingLedger: () => billingLedger,
  admitInferenceChargeViaLedger,
  createLedgerDebitSettler,
}));

// Synchronous reserve path — spied so we can prove it is the fallback. billUsage
// is a no-op return (the settle is not the observation point here).
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits,
  billUsage: async () => ({
    inputCost: BACKSTOP_COST,
    outputCost: 0,
    totalCost: BACKSTOP_COST,
    baseInputCost: BACKSTOP_COST,
    baseOutputCost: 0,
    baseTotalCost: BACKSTOP_COST,
    platformMarkup: 0,
    inputTokens: 5,
    outputTokens: 0,
    totalTokens: 5,
    markupApplied: true,
  }),
}));

mock.module("@/lib/services/usage", () => ({
  ...usageActual,
  usageService: {
    ...usageActual.usageService,
    create: async () => ({ id: "u" }),
  },
}));

// Embedder: succeeds so the route reaches AND passes the billing decision and
// returns 200; the decision spies are the observation point.
mock.module("ai", () => ({
  ...aiActual,
  embed: async () => ({ embedding: EMBEDDING, usage: { tokens: 5 } }),
  embedMany: async () => ({ embeddings: [EMBEDDING], usage: { tokens: 5 } }),
}));

// Import the route AFTER the mocks so it binds to the stubs.
const embeddingsRoute = (await import("../v1/embeddings/route")).default;

afterAll(() => {
  // Leave the knobs fail-safe BEFORE restoring the modules: bun's mock.module
  // can leave already-evaluated importers (the route, first loaded by an
  // earlier test file) bound to the mocked functions even after the registry
  // restore below, and those closures read these knobs by reference. A leaked
  // `billingEnabled=true` (or a "db" ledger) would silently flip LATER test
  // files' requests onto an optimistic path their suites never account for.
  billingEnabled = false;
  billingLedger = "kv";
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthActual,
  );
  mock.module("@/lib/middleware/rate-limit", () => rateLimitActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/pricing", () => pricingActual);
  mock.module(
    "@/lib/services/inference-billing-fast-path",
    () => fastPathActual,
  );
  mock.module("@/lib/services/inference-billing-ledger", () => ledgerActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module("@/lib/services/usage", () => usageActual);
  mock.module("ai", () => aiActual);
});

function makeExecutionCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        scheduled.push(Promise.resolve(p));
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
    scheduled,
  };
}

function post(body: unknown, ctx?: ExecutionContext, affiliateCode?: string) {
  return embeddingsRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
        "x-request-id": CLIENT_REQUEST_ID,
        ...(affiliateCode ? { "X-Affiliate-Code": affiliateCode } : {}),
      },
      body: JSON.stringify(body),
    },
    {},
    ctx,
  );
}

describe("POST /api/v1/embeddings optimistic-billing route decision (#9899/#10106)", () => {
  beforeEach(() => {
    billingEnabled = true;
    backstopAvailable = true;
    gateBalanceUsd = 100;
    thresholdUsd = 5;
    backstopPersists = true;
    billingLedger = "kv";
    writePendingInferenceCharge.mockClear();
    reserveCredits.mockClear();
    createOptimisticDebitSettler.mockClear();
    admitInferenceChargeViaLedger.mockClear();
    createLedgerDebitSettler.mockClear();
  });

  test("eligible org takes the optimistic path: writes backstop, skips the synchronous reserve", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );
    await Promise.all(scheduled);
    expect(res.status).toBe(200);
    expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
    expect(createOptimisticDebitSettler).toHaveBeenCalledTimes(1);
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  test("billing requestId is server-generated, not copied from x-request-id", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );
    await Promise.all(scheduled);

    expect(res.status).toBe(200);
    const pendingCalls = writePendingInferenceCharge.mock
      .calls as unknown as Array<[{ requestId: string }, number]>;
    const settlerCalls = createOptimisticDebitSettler.mock
      .calls as unknown as Array<[{ requestId: string }]>;
    const pending = pendingCalls[0]?.[0];
    const settler = settlerCalls[0]?.[0];
    expect(pending).toBeDefined();
    expect(settler).toBeDefined();
    if (!pending || !settler) throw new Error("billing path was not reached");

    expect(pending.requestId).toMatch(UUID_RE);
    expect(pending.requestId).not.toBe(CLIENT_REQUEST_ID);
    expect(settler.requestId).toBe(pending.requestId);
  });

  test("backstop records the REAL input-token cost estimate (not 0) so a dropped settle is recoverable", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    await post({ model: "text-embedding-3-small", input: "hi" }, ctx);
    await Promise.all(scheduled);
    expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
    const pending = writePendingInferenceCharge.mock.calls[0]?.[0] as {
      estimatedCostUsd: number;
    };
    expect(pending.estimatedCostUsd).toBe(BACKSTOP_COST);
    expect(pending.estimatedCostUsd).toBeGreaterThan(0);
  });

  test("billing requestId is server-generated, not copied from x-request-id", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );
    await Promise.all(scheduled);

    expect(res.status).toBe(200);
    const pendingCalls = writePendingInferenceCharge.mock
      .calls as unknown as Array<[{ requestId: string }, number]>;
    const settlerCalls = createOptimisticDebitSettler.mock
      .calls as unknown as Array<[{ requestId: string }]>;
    const pending = pendingCalls[0]?.[0];
    const settler = settlerCalls[0]?.[0];
    expect(pending).toBeDefined();
    expect(settler).toBeDefined();
    if (!pending || !settler) throw new Error("billing path was not reached");

    expect(pending.requestId).toMatch(UUID_RE);
    expect(pending.requestId).not.toBe(CLIENT_REQUEST_ID);
    expect(settler.requestId).toBe(pending.requestId);
  });

  test("balance below SAFE_BALANCE_THRESHOLD falls back to the synchronous reserve", async () => {
    gateBalanceUsd = 2; // < threshold 5 → not eligible
    const { ctx, scheduled } = makeExecutionCtx();
    await post({ model: "text-embedding-3-small", input: "hi" }, ctx);
    await Promise.all(scheduled);
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(createOptimisticDebitSettler).not.toHaveBeenCalled();
  });

  test("backstop not writable (cache down) falls back to the synchronous reserve", async () => {
    backstopAvailable = false;
    const { ctx, scheduled } = makeExecutionCtx();
    await post({ model: "text-embedding-3-small", input: "hi" }, ctx);
    await Promise.all(scheduled);
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  });

  test("optimistic billing flag OFF takes the synchronous reserve (default-safe)", async () => {
    billingEnabled = false;
    const { ctx, scheduled } = makeExecutionCtx();
    await post({ model: "text-embedding-3-small", input: "hi" }, ctx);
    await Promise.all(scheduled);
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  });

  test("non-durable backstop write falls back to the synchronous reserve (never forwards un-recorded)", async () => {
    backstopPersists = false;
    const { ctx, scheduled } = makeExecutionCtx();
    await post({ model: "text-embedding-3-small", input: "hi" }, ctx);
    await Promise.all(scheduled);
    // POSITIVE: the backstop write was attempted (decision chose optimistic)...
    expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
    // ...but a non-durable write must fall through to the synchronous reserve.
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(createOptimisticDebitSettler).not.toHaveBeenCalled();
  });

  // #12017: the optimistic branches admit on a BASE-cost estimate and this
  // route's billUsage runs without the reservation (#10557), so an affiliate
  // markup (attacker-set, up to 1000%) would be minted as cashable earnings
  // against money the admission gate never accounted for. A request carrying
  // X-Affiliate-Code must therefore take the SYNCHRONOUS reserve, whose hold
  // folds the markup (reserveCredits → resolveBillableAffiliate →
  // estimatedCostMultiplier — the markup arithmetic itself is pinned by
  // embeddings-affiliate-reserve.test.ts).
  test("X-Affiliate-Code forces the synchronous reserve even when the KV optimistic path is eligible (#12017)", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
      "PARTNER1000",
    );
    await Promise.all(scheduled);
    expect(res.status).toBe(200);

    // Neither optimistic admission may see a marked-up request…
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(createOptimisticDebitSettler).not.toHaveBeenCalled();
    // …the synchronous reserve runs and CARRIES the affiliate, so the hold
    // covers base + markup and an uncollectable settle can't mint earnings.
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    const reserveCalls = reserveCredits.mock.calls as unknown as Array<
      [{ affiliateCode?: string | null }]
    >;
    expect(reserveCalls[0]?.[0]?.affiliateCode).toBe("PARTNER1000");
  });

  test("X-Affiliate-Code also bypasses the DB-ledger optimistic branch (#12017)", async () => {
    billingLedger = "db";

    // Positive control: WITHOUT the header the ledger branch admits and the
    // synchronous reserve is skipped — proving the gate below is affiliate-
    // specific, not a broken ledger branch.
    const control = makeExecutionCtx();
    const controlRes = await post(
      { model: "text-embedding-3-small", input: "hi" },
      control.ctx,
    );
    await Promise.all(control.scheduled);
    expect(controlRes.status).toBe(200);
    expect(admitInferenceChargeViaLedger).toHaveBeenCalledTimes(1);
    expect(reserveCredits).not.toHaveBeenCalled();

    admitInferenceChargeViaLedger.mockClear();
    createLedgerDebitSettler.mockClear();
    reserveCredits.mockClear();

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
      "PARTNER1000",
    );
    await Promise.all(scheduled);
    expect(res.status).toBe(200);

    expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
    expect(createLedgerDebitSettler).not.toHaveBeenCalled();
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    const reserveCalls = reserveCredits.mock.calls as unknown as Array<
      [{ affiliateCode?: string | null }]
    >;
    expect(reserveCalls[0]?.[0]?.affiliateCode).toBe("PARTNER1000");
  });
});
