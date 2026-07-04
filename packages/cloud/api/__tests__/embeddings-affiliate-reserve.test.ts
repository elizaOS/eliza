/**
 * Guard tests for #12017 — /v1/embeddings must not mint affiliate earnings on
 * an uncollectable-overage settle (#11972 residual missed by #11976).
 *
 * #11976 made the chat/messages routes safe by folding the affiliate markup
 * into the upfront credit hold (reserveCredits receives `affiliateCode` →
 * `estimatedCostMultiplier = 1 + markup`), so the later cashable
 * `redeemableEarningsService.addEarnings` credit is always backed by money the
 * platform actually collected. The embeddings route omitted `affiliateCode`
 * from its reserve context: the hold was base+platform only (× the 1.5
 * COST_BUFFER), while billUsage still credited the affiliate the FULL
 * attacker-set markup (up to 1000%) — so a 2-account colluder could drain the
 * uncollectable delta as cashable earnings, repeatable per request.
 *
 * These tests drive the REAL route + the REAL reserveCredits/billUsage from
 * ai-billing (the affiliate resolution, markup math, and earnings credit all
 * run for real). Only the deep boundaries are stubbed: auth, rate limit, the
 * embedder, pricing's calculateCost (deterministic $0.10 base), the affiliate
 * lookup, the credits ledger reserve, and the earnings/usage writers. The
 * reserve stub reproduces the real ledger arithmetic
 * (`estimatedCost × multiplier × COST_BUFFER`) so the tests can assert the
 * money invariant itself: reserved ≥ settled, i.e. the affiliate payout is
 * fully covered by the hold.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as affiliatesActual from "@/db/repositories/affiliates";
import * as workersHonoAuthActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
import * as pricingActual from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as creditsActual from "@/lib/services/credits";
import * as inferenceAuthActual from "@/lib/services/inference-auth-context";
import * as redeemableEarningsActual from "@/lib/services/redeemable-earnings";
import * as usageActual from "@/lib/services/usage";

process.env.DATABASE_URL ||= "pglite://memory";
// Force the synchronous-reserve path (the one #12017 is about): optimistic
// billing off, no DB ledger.
process.env.INFERENCE_OPTIMISTIC_BILLING = "";
process.env.INFERENCE_BILLING_LEDGER = "";
delete process.env.CREDIT_COST_BUFFER; // default 1.5, mirrored by the stub

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const AFFILIATE_USER = "00000000-0000-4000-8000-00000000aff1";

const EMBEDDING = [0.0125, -0.5, 0.333333];
const BASE_COST = 0.1; // deterministic base+platform cost from calculateCost
const COST_BUFFER = 1.5; // credits.ts default (CREDIT_COST_BUFFER unset)

// --- Auth / rate limit / provider config: same harness as the sibling
// embeddings suites. ---------------------------------------------------------
const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...workersHonoAuthActual,
  requireUserOrApiKeyWithOrg,
}));

const enforceOrgRateLimit = mock();
mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit,
}));

const resolveInferenceAuthContext = mock();
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthActual,
  resolveInferenceAuthContext,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  hasTextEmbeddingProviderConfigured: () => true,
  getTextEmbeddingModel: () => ({}) as never,
  resolveEmbeddingProviderSource: () => "openai",
  getAiProviderConfigurationError: () => "AI services are not configured",
}));

// --- Deterministic pricing so the affiliate math is exact. -------------------
mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost: mock(async () => ({
    inputCost: BASE_COST,
    outputCost: 0,
    totalCost: BASE_COST,
  })),
}));

// --- Affiliate lookup: attacker-set 1000% markup owned by AFFILIATE_USER. ----
let affiliateUserId = AFFILIATE_USER;
let affiliateActive = true;
const getAffiliateCodeByCode = mock(async () => ({
  id: "aff-code-1",
  user_id: affiliateUserId,
  markup_percent: "1000",
  is_active: affiliateActive,
}));
mock.module("@/db/repositories/affiliates", () => ({
  ...affiliatesActual,
  affiliatesRepository: new Proxy(affiliatesActual.affiliatesRepository, {
    get: (target, prop, receiver) =>
      prop === "getAffiliateCodeByCode"
        ? getAffiliateCodeByCode
        : Reflect.get(target, prop, receiver),
  }),
}));

// --- Credits ledger: reserve stub reproducing the REAL hold arithmetic
// (credits.ts reserve(): estimatedCost × estimatedCostMultiplier, buffered by
// COST_BUFFER) so reservedAmount is faithful to what prod would hold. ---------
const reconcile = mock(async (_actualCost: number) => undefined);
const reserve = mock(
  async (
    params: { estimatedCostMultiplier?: number } & Record<string, unknown>,
  ) => {
    const multiplier = params.estimatedCostMultiplier ?? 1;
    return {
      reservedAmount: BASE_COST * multiplier * COST_BUFFER,
      reservationTransactionId: "reservation-1",
      reconcile,
    };
  },
);
mock.module("@/lib/services/credits", () => ({
  ...creditsActual,
  creditsService: new Proxy(creditsActual.creditsService, {
    get: (target, prop, receiver) =>
      prop === "reserve" ? reserve : Reflect.get(target, prop, receiver),
  }),
}));

// --- The cashable write that must never exceed collected money. --------------
const addEarnings = mock(async (_params: Record<string, unknown>) => ({
  ledgerId: "ledger-1",
}));
mock.module("@/lib/services/redeemable-earnings", () => ({
  ...redeemableEarningsActual,
  redeemableEarningsService: new Proxy(
    redeemableEarningsActual.redeemableEarningsService,
    {
      get: (target, prop, receiver) =>
        prop === "addEarnings"
          ? addEarnings
          : Reflect.get(target, prop, receiver),
    },
  ),
}));

// --- Route-level usage writer (not under test). ------------------------------
const usageCreate = mock();
mock.module("@/lib/services/usage", () => ({
  ...usageActual,
  usageService: new Proxy(usageActual.usageService, {
    get: (target, prop, receiver) =>
      prop === "create" ? usageCreate : Reflect.get(target, prop, receiver),
  }),
}));

// --- The embedder. ------------------------------------------------------------
const embed = mock();
const embedMany = mock();
mock.module("ai", () => ({
  ...aiActual,
  embed,
  embedMany,
}));

// Import the route AFTER the mocks. ai-billing (reserveCredits, billUsage,
// resolveBillableAffiliate, the earnings clamp) is REAL — it is the code under
// test together with the route's reserve context.
const embeddingsRoute = (await import("../v1/embeddings/route")).default;

afterAll(() => {
  mock.module("@/lib/auth/workers-hono-auth", () => workersHonoAuthActual);
  mock.module("@/lib/middleware/rate-limit", () => rateLimitActual);
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthActual,
  );
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/pricing", () => pricingActual);
  mock.module("@/db/repositories/affiliates", () => affiliatesActual);
  mock.module("@/lib/services/credits", () => creditsActual);
  mock.module(
    "@/lib/services/redeemable-earnings",
    () => redeemableEarningsActual,
  );
  mock.module("@/lib/services/usage", () => usageActual);
  mock.module("ai", () => aiActual);
});

type AppCtx = { set: (k: string, v: unknown) => void };

/** Collects the promises scheduled via executionCtx.waitUntil. */
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

function post(body: unknown, ctx: ExecutionContext, affiliateCode?: string) {
  return embeddingsRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
        ...(affiliateCode ? { "X-Affiliate-Code": affiliateCode } : {}),
      },
      body: JSON.stringify(body),
    },
    {},
    ctx,
  );
}

beforeEach(() => {
  affiliateUserId = AFFILIATE_USER;
  affiliateActive = true;
  requireUserOrApiKeyWithOrg.mockClear();
  resolveInferenceAuthContext.mockClear();
  enforceOrgRateLimit.mockClear();
  getAffiliateCodeByCode.mockClear();
  reserve.mockClear();
  reconcile.mockClear();
  addEarnings.mockClear();
  usageCreate.mockClear();
  embed.mockClear();
  embedMany.mockClear();

  requireUserOrApiKeyWithOrg.mockImplementation(async (c: AppCtx) => {
    c.set("apiKeyId", API_KEY_ID);
    return {
      id: USER,
      organization_id: ORG,
      organization: { id: ORG, name: "Org", is_active: true },
      is_active: true,
    };
  });
  resolveInferenceAuthContext.mockResolvedValue({
    kind: "slow_path",
    reason: "non_api_key",
  });
  enforceOrgRateLimit.mockResolvedValue(null);
  usageCreate.mockResolvedValue({ id: "usage-1" });
  embed.mockResolvedValue({ embedding: EMBEDDING, usage: { tokens: 5 } });
  embedMany.mockResolvedValue({
    embeddings: [EMBEDDING, EMBEDDING],
    usage: { tokens: 10 },
  });
});

describe("POST /api/v1/embeddings — affiliate markup is reserved upfront (#12017)", () => {
  test("X-Affiliate-Code folds the markup into the hold, so the affiliate credit is fully collected", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
      "PARTNER1000",
    );
    expect(res.status).toBe(200);
    await Promise.all(scheduled);

    // The load-bearing #12017 assertion: the reserve context carried the
    // affiliate, so the ledger hold includes the 1000% markup — exactly like
    // /v1/messages and /v1/chat/completions after #11976.
    expect(reserve).toHaveBeenCalledTimes(1);
    const reserveArg = reserve.mock.calls[0][0] as {
      organizationId: string;
      estimatedCostMultiplier?: number;
    };
    expect(reserveArg.organizationId).toBe(ORG);
    expect(reserveArg.estimatedCostMultiplier).toBeCloseTo(11, 6);

    // The settle charges the full marked-up cost against that hold …
    expect(reconcile).toHaveBeenCalledTimes(1);
    const settledCost = reconcile.mock.calls[0][0] as number;
    expect(settledCost).toBeCloseTo(BASE_COST * 11, 6); // $0.10 × (1 + 1000%)

    // … and the hold COVERS it (reserved ≥ actual): no uncollectable overage,
    // so the cashable affiliate credit below is backed by collected money.
    // Pre-fix the hold was BASE_COST × 1.5 = $0.15 vs a $1.10 settle.
    const reservation = (await reserve.mock.results[0].value) as {
      reservedAmount: number;
    };
    expect(reservation.reservedAmount).toBeGreaterThanOrEqual(settledCost);

    expect(addEarnings).toHaveBeenCalledTimes(1);
    const earningsArg = addEarnings.mock.calls[0][0] as {
      userId: string;
      amount: number;
      source: string;
      dedupeBySourceId: boolean;
    };
    expect(earningsArg.userId).toBe(AFFILIATE_USER);
    expect(earningsArg.source).toBe("affiliate");
    expect(earningsArg.amount).toBeCloseTo(BASE_COST * 10, 6); // the markup, now collected
    expect(earningsArg.dedupeBySourceId).toBe(true);
  });

  test("no X-Affiliate-Code header → no multiplier on the hold and no earnings", async () => {
    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
    );
    expect(res.status).toBe(200);
    await Promise.all(scheduled);

    expect(reserve).toHaveBeenCalledTimes(1);
    const reserveArg = reserve.mock.calls[0][0] as {
      estimatedCostMultiplier?: number;
    };
    expect(reserveArg.estimatedCostMultiplier).toBeUndefined();

    // Base+platform only settled; no affiliate mint.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][0]).toBeCloseTo(BASE_COST, 6);
    expect(addEarnings).not.toHaveBeenCalled();
  });

  test("self-referral via embeddings neither inflates the hold nor mints earnings", async () => {
    affiliateUserId = USER;

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: "hi" },
      ctx,
      "PARTNER1000",
    );
    expect(res.status).toBe(200);
    await Promise.all(scheduled);

    const reserveArg = reserve.mock.calls[0][0] as {
      estimatedCostMultiplier?: number;
    };
    expect(reserveArg.estimatedCostMultiplier).toBeUndefined();
    expect(reconcile.mock.calls[0][0]).toBeCloseTo(BASE_COST, 6);
    expect(addEarnings).not.toHaveBeenCalled();
  });

  test("inactive affiliate code is ignored on both the hold and the settle", async () => {
    affiliateActive = false;

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await post(
      { model: "text-embedding-3-small", input: ["a", "b"] },
      ctx,
      "PARTNER1000",
    );
    expect(res.status).toBe(200);
    await Promise.all(scheduled);

    const reserveArg = reserve.mock.calls[0][0] as {
      estimatedCostMultiplier?: number;
    };
    expect(reserveArg.estimatedCostMultiplier).toBeUndefined();
    expect(reconcile.mock.calls[0][0]).toBeCloseTo(BASE_COST, 6);
    expect(addEarnings).not.toHaveBeenCalled();
  });
});
