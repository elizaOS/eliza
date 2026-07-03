/**
 * #12017 — /v1/embeddings affiliate markup must be fail-closed AND clamped to
 * collected money, proven end to end on the real ledger.
 *
 * Residual of #11972 that #11976 missed: the embeddings reserve omitted
 * `affiliateCode`, so the upfront hold was base+platform only (buffered by
 * COST_BUFFER=1.5) while billUsage credited the affiliate the FULL
 * preAffiliateTotalCost × markup% (up to 1000%). With an org funded to just the
 * base reserve, the affiliate delta settled as an `uncollected_overage` (no
 * throw) and the earnings write stood — 2-account collusion minted ~10× the
 * collected revenue as cashable `redeemable_earnings`, repeatable per request.
 *
 * #12047 landed leg 1 (thread affiliateCode into the reserve) with a
 * stubbed-ledger guard suite. This suite adds the REAL-money proof for leg 1
 * AND covers leg 2, which #12047 left open: billUsage still ran WITHOUT the
 * reservation, so the #11976 `collectedAffiliateEarnings` clamp was dead on
 * this route — when the provider-reported token count blows past the buffered
 * estimate (estimateTokens is chars/4; CJK/emoji inputs tokenize at >1.5×
 * that), the overage is uncollectable yet the affiliate was still credited the
 * full nominal markup. Leg 2 hands billUsage a settler-backed reservation view
 * so cashable earnings can never exceed the collected markup.
 *
 * These tests drive the REAL route handler + REAL ai-billing / credits SQL
 * (reserve → reconcile CTEs) + REAL pricing catalog (a seeded
 * ai_pricing_entries row — no pricing mock, so the suite is immune to
 * mock.module ordering across files) + REAL affiliates repository + REAL
 * redeemable-earnings service against PGlite. Only the external seams are
 * stubbed: auth, org rate limit, the embedding provider (`ai` embed/embedMany),
 * usage analytics, and the fire-and-forget post-debit notifications —
 * mirroring domains-buy-cross-app-replay.integration.test.ts.
 *
 * Pinned invariants (the #11976 contract, now on this route too):
 *   1. The reserve INCLUDES the affiliate markup → an org funded to only the
 *      base hold gets a 402 BEFORE the provider call. Nothing is minted.
 *   2. A fully funded org still pays the affiliate the full markup (legit
 *      third-party affiliate flow intact).
 *   3. When the actual cost blows past the reserve and the overage is
 *      uncollectable, the affiliate is paid ONLY from the collected markup —
 *      0 when nothing above the base cost was collected.
 *
 * Self-skips LOUDLY (pgliteReady) if PGlite/pushSchema is unavailable.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { closeDatabaseConnectionsForTests, dbRead, dbWrite } from "@/db/client";
// Via cloud-shared so `drizzle-kit` (its devDependency) resolves at runtime.
import { pushSchema } from "@/db/push-schema-for-tests";
import { affiliateCodes } from "@/db/schemas/affiliates";
import { aiPricingEntries } from "@/db/schemas/ai-pricing";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { organizations } from "@/db/schemas/organizations";
import {
  earningsSourceEnum,
  ledgerEntryTypeEnum,
  redeemableEarnings,
  redeemableEarningsLedger,
  redeemedEarningsTracking,
} from "@/db/schemas/redeemable-earnings";
import { users } from "@/db/schemas/users";
import * as realAuth from "@/lib/auth/workers-hono-auth";
import * as realRateLimit from "@/lib/middleware/rate-limit";
import { PLATFORM_MARKUP_MULTIPLIER } from "@/lib/pricing";
import * as realAutoTopUp from "@/lib/services/auto-top-up";
import * as realEmail from "@/lib/services/email";
import * as realInferenceAuth from "@/lib/services/inference-auth-context";
import * as realUsage from "@/lib/services/usage";
import * as realWaifu from "@/lib/services/waifu-webhook";
import type { AppEnv } from "@/types/cloud-worker-env";

const ENV = {
  NODE_ENV: "test",
  MOCK_REDIS: "1",
} as unknown as AppEnv["Bindings"];

const PGLITE_TIMEOUT = 180_000;
let pgliteReady = true;

// REAL catalog pricing: a seeded ai_pricing_entries row at $0.001/token for a
// model name unique to this suite (so no other file's pricing-cache entries can
// shadow it). COST_BUFFER stays at its default 1.5; the catalog applies the
// platform markup (PLATFORM_MARKUP_MULTIPLIER). The 400-char input below
// estimates to 100 tokens → base+platform estimate $0.12 → pre-fix hold $0.18;
// with the 1000% affiliate threaded in, the hold is $0.12 × 11 × 1.5 = $1.98.
const MODEL = "test-embedding-12017";
const USD_PER_TOKEN = 0.001;
const INPUT = "x".repeat(400); // estimateTokens → 100
const EST_TOKENS = 100;
const EST_TOTAL = EST_TOKENS * USD_PER_TOKEN * PLATFORM_MARKUP_MULTIPLIER;
const AFFILIATE_MULTIPLIER = 11; // 1 + 1000%
const COST_BUFFER = 1.5;
const BASE_ONLY_HOLD = EST_TOTAL * COST_BUFFER; // pre-#12017 reserve
const AFFILIATE_HOLD = EST_TOTAL * AFFILIATE_MULTIPLIER * COST_BUFFER;
/** base+platform cost the catalog yields for `tokens` actual tokens. */
function actualTotal(tokens: number): number {
  return tokens * USD_PER_TOKEN * PLATFORM_MARKUP_MULTIPLIER;
}

// ---- external seams ---------------------------------------------------------

let authOrgId = "";
let authUserId = "";
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: authUserId,
  organization_id: authOrgId,
  organization: { id: authOrgId, name: "Caller Org", is_active: true },
  is_active: true,
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg,
}));

const resolveInferenceAuthContext = mock(async () => ({
  kind: "slow_path" as const,
  reason: "non_api_key",
}));
mock.module("@/lib/services/inference-auth-context", () => ({
  ...realInferenceAuth,
  resolveInferenceAuthContext,
}));

mock.module("@/lib/middleware/rate-limit", () => ({
  ...realRateLimit,
  enforceOrgRateLimit: mock(async () => null),
}));

mock.module("@/lib/providers/language-model", () => ({
  hasTextEmbeddingProviderConfigured: () => true,
  getTextEmbeddingModel: () => ({}) as never,
  resolveEmbeddingProviderSource: () => "openai",
  getAiProviderConfigurationError: () => "AI services are not configured",
}));

// The embedding provider — usage.tokens is the per-test lever that makes the
// ACTUAL cost match or blow past the estimated reserve.
const EMBEDDING = [0.25, -0.5, 0.75];
let actualUsageTokens = 100;
const embed = mock(async () => ({
  embedding: EMBEDDING,
  usage: { tokens: actualUsageTokens },
}));
const embedMany = mock(async () => ({
  embeddings: [EMBEDDING],
  usage: { tokens: actualUsageTokens },
}));
mock.module("ai", () => ({
  ...(require("ai") as object),
  embed,
  embedMany,
}));

// Usage analytics is not the money under test.
mock.module("@/lib/services/usage", () => ({
  ...realUsage,
  usageService: {
    ...realUsage.usageService,
    create: mock(async () => ({ id: "usage-1" })),
  },
}));

// Fire-and-forget post-debit notifications (NOT the code under test) — same
// stubs as domains-buy-cross-app-replay.integration.test.ts. The reserve /
// reconcile / earnings SQL itself runs entirely real against PGlite.
mock.module("@/lib/services/email", () => ({
  emailService: { sendLowCreditsEmail: mock(async () => false) },
}));
mock.module("@/lib/services/waifu-webhook", () => ({
  resolveWaifuWebhookTarget: mock(() => null),
  classifyCreditBalance: mock(() => null),
  emitWaifuCreditWebhook: mock(async () => undefined),
}));
mock.module("@/lib/services/auto-top-up", () => ({
  autoTopUpService: { executeAutoTopUp: mock(async () => undefined) },
}));

// Import the route AFTER the seam mocks (it binds them at module-eval time).
// NOTE: this suite needs the REAL @/lib/services/ai-billing + credits +
// pricing modules, which sibling suites replace via mock.module. That is safe
// ONLY under the package's `test` lane (test/run-unit-isolated.mjs — one bun
// process per file); a combined `bun test __tests__` run cross-contaminates
// module mocks process-wide, which that runner exists to prevent.
const { default: embeddingsRoute } = await import("../v1/embeddings/route");

const api = new Hono<AppEnv>();
api.route("/api/v1/embeddings", embeddingsRoute);

afterAll(async () => {
  mock.module("@/lib/auth/workers-hono-auth", () => realAuth);
  mock.module("@/lib/services/inference-auth-context", () => realInferenceAuth);
  mock.module("@/lib/middleware/rate-limit", () => realRateLimit);
  mock.module("@/lib/services/usage", () => realUsage);
  mock.module("@/lib/services/email", () => realEmail);
  mock.module("@/lib/services/waifu-webhook", () => realWaifu);
  mock.module("@/lib/services/auto-top-up", () => realAutoTopUp);
  await closeDatabaseConnectionsForTests();
});

// ---- world ------------------------------------------------------------------

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Seed a caller org+user funded to `balanceUsd`, plus a SEPARATE affiliate
 * user owning a 1000%-markup code. Points the auth mock at the caller. */
async function seedScenario(balanceUsd: number): Promise<{
  orgId: string;
  affiliateUserId: string;
  code: string;
}> {
  const [callerOrg] = await dbWrite
    .insert(organizations)
    .values({
      name: "Caller Org",
      slug: uniq("caller-org"),
      credit_balance: String(balanceUsd),
    })
    .returning();
  const [caller] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: uniq("caller"),
      organization_id: callerOrg.id,
    })
    .returning();

  const [affiliateOrg] = await dbWrite
    .insert(organizations)
    .values({ name: "Affiliate Org", slug: uniq("affiliate-org") })
    .returning();
  const [affiliateUser] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: uniq("affiliate"),
      organization_id: affiliateOrg.id,
    })
    .returning();
  const code = uniq("PUMP1000").toUpperCase();
  await dbWrite.insert(affiliateCodes).values({
    user_id: affiliateUser.id,
    code,
    markup_percent: "1000.00",
    is_active: true,
  });

  authOrgId = callerOrg.id;
  authUserId = caller.id;
  return { orgId: callerOrg.id, affiliateUserId: affiliateUser.id, code };
}

/** Collects the promises scheduled via executionCtx.waitUntil so the deferred
 * settleBilling (billUsage → reconcile → earnings) can be awaited. */
function makeExecutionCtx() {
  const scheduled: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        scheduled.push(Promise.resolve(p).catch(() => undefined));
      },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext,
    scheduled,
  };
}

async function postEmbeddings(
  affiliateCode: string,
  ctx: ExecutionContext,
): Promise<Response> {
  return api.request(
    "/api/v1/embeddings",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
        "X-Affiliate-Code": affiliateCode,
      },
      body: JSON.stringify({ model: MODEL, input: INPUT }),
    },
    ENV,
    ctx,
  );
}

async function orgBalance(orgId: string): Promise<number> {
  const [org] = await dbRead
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return Number(org.credit_balance);
}

async function orgLedgerCount(orgId: string): Promise<number> {
  const rows = await dbRead
    .select({ id: creditTransactions.id })
    .from(creditTransactions)
    .where(eq(creditTransactions.organization_id, orgId));
  return rows.length;
}

async function affiliateAvailableBalance(userId: string): Promise<number> {
  const row = await dbRead.query.redeemableEarnings.findFirst({
    where: eq(redeemableEarnings.user_id, userId),
  });
  return Number(row?.available_balance ?? 0);
}

async function affiliateEarningLedger(userId: string) {
  return dbRead.query.redeemableEarningsLedger.findMany({
    where: eq(redeemableEarningsLedger.user_id, userId),
  });
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    const schema = {
      organizations,
      users,
      creditTransactions,
      affiliateCodes,
      aiPricingEntries,
      earningsSourceEnum,
      ledgerEntryTypeEnum,
      redeemableEarnings,
      redeemableEarningsLedger,
      redeemedEarningsTracking,
    };
    const { apply } = await pushSchema(schema as never, dbWrite as never);
    await apply();
    // Real catalog price for the suite's model: $0.001/token on the input
    // side (embeddings bill no output tokens). The lookup canonicalizes
    // "test-embedding-12017" + provider "openai" to "openai/test-embedding-12017"
    // and resolves billingSource "openai" first.
    await dbWrite.insert(aiPricingEntries).values({
      billing_source: "openai",
      provider: "openai",
      model: `openai/${MODEL}`,
      product_family: "embedding",
      charge_type: "input",
      unit: "token",
      unit_price: String(USD_PER_TOKEN),
      source_kind: "manual",
      source_url: "test://embeddings-affiliate-reserve",
      is_active: true,
    });
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[embeddings-affiliate-reserve.test] PGlite/pushSchema unavailable — skipping.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

describe("POST /v1/embeddings — affiliate markup is reserved upfront (#12017)", () => {
  test("pglite applied (loud)", () => {
    expect(pgliteReady).toBe(true);
  });

  test("org funded to only the base hold → 402 fail-closed BEFORE embedding; nothing minted", async () => {
    if (!pgliteReady) return;

    // Fund to 2× the pre-fix reserve ($0.36 — comfortably clears the $0.18
    // base-only hold, nowhere near the $1.98 affiliate-inclusive hold).
    // Pre-#12017 this request succeeded, credited the affiliate $1.20
    // cashable, and settled the delta as an uncollected overage.
    const { orgId, affiliateUserId, code } = await seedScenario(
      BASE_ONLY_HOLD * 2,
    );
    actualUsageTokens = EST_TOKENS;
    embed.mockClear();

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await postEmbeddings(code, ctx);
    await Promise.all(scheduled);

    // The affiliate-inclusive hold ($1.98) exceeds the balance → fail-closed.
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("insufficient_balance");

    // Terminal guard: no provider call, no deferred billing, no money moved.
    expect(embed).not.toHaveBeenCalled();
    expect(scheduled.length).toBe(0);
    expect(await orgBalance(orgId)).toBeCloseTo(BASE_ONLY_HOLD * 2, 6);
    expect(await orgLedgerCount(orgId)).toBe(0);

    // The load-bearing assertion: NO cashable earnings for the affiliate.
    expect(await affiliateAvailableBalance(affiliateUserId)).toBe(0);
    expect(await affiliateEarningLedger(affiliateUserId)).toHaveLength(0);
  });

  test("fully funded org: request succeeds and the affiliate earns the full collected markup (legit flow intact)", async () => {
    if (!pgliteReady) return;

    const { orgId, affiliateUserId, code } = await seedScenario(10);
    actualUsageTokens = EST_TOKENS; // actual == estimate → base+platform $0.12

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await postEmbeddings(code, ctx);
    expect(res.status).toBe(200);
    await Promise.all(scheduled);

    // Charged the full marked-up cost on the ledger: $0.12 × 11 = $1.32
    // (reserve $1.98 → refund $0.66 at reconcile).
    expect(await orgBalance(orgId)).toBeCloseTo(
      10 - EST_TOTAL * AFFILIATE_MULTIPLIER,
      4,
    );

    // Affiliate earned the markup — fully collected, fully paid: $1.20.
    expect(await affiliateAvailableBalance(affiliateUserId)).toBeCloseTo(
      EST_TOTAL * (AFFILIATE_MULTIPLIER - 1),
      4,
    );
    const ledger = await affiliateEarningLedger(affiliateUserId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].entry_type).toBe("earning");
    expect(ledger[0].earnings_source).toBe("affiliate");
    // #11588: dedupe sourceId is keyed by the server-generated requestId. The
    // ledger stores it normalized to a deterministic UUID and preserves the
    // original in metadata.original_source_id.
    expect(
      (ledger[0].metadata as { original_source_id?: string })
        .original_source_id,
    ).toStartWith("ai_billing:usage:");
  });

  test("uncollectable overage above the base cost → affiliate paid 0 (clamp is live on this route)", async () => {
    if (!pgliteReady) return;

    // Fund a hair above the affiliate-inclusive hold so the reserve succeeds
    // and the org is then drained. The provider reports 20× the estimated
    // tokens: actual base+platform $2.40 > collected $1.98, so NOTHING above
    // the base cost was collected → the #11976 clamp must pay the affiliate 0,
    // not the nominal $24.00.
    const { orgId, affiliateUserId, code } = await seedScenario(
      AFFILIATE_HOLD + 0.01,
    );
    actualUsageTokens = EST_TOKENS * 20;

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await postEmbeddings(code, ctx);
    expect(res.status).toBe(200);
    await Promise.all(scheduled);

    // Only the reserve was collectable; the overage debit failed closed.
    expect(await orgBalance(orgId)).toBeCloseTo(0.01, 4);
    expect(await affiliateAvailableBalance(affiliateUserId)).toBe(0);
    expect(await affiliateEarningLedger(affiliateUserId)).toHaveLength(0);
  });

  test("uncollectable overage with PARTIAL markup collection → affiliate paid exactly the collected markup", async () => {
    if (!pgliteReady) return;

    // Actual = 10× estimate: base+platform $1.20, nominal earnings $12.00, but
    // only the $1.98 reserve is collectable → payable = $1.98 − $1.20 = $0.78.
    const { orgId, affiliateUserId, code } = await seedScenario(
      AFFILIATE_HOLD + 0.01,
    );
    actualUsageTokens = EST_TOKENS * 10;
    const collectedMarkup = AFFILIATE_HOLD - actualTotal(EST_TOKENS * 10);

    const { ctx, scheduled } = makeExecutionCtx();
    const res = await postEmbeddings(code, ctx);
    expect(res.status).toBe(200);
    await Promise.all(scheduled);

    expect(await orgBalance(orgId)).toBeCloseTo(0.01, 4);
    // Earnings == collected markup — never preAffiliateTotalCost × markup%.
    expect(await affiliateAvailableBalance(affiliateUserId)).toBeCloseTo(
      collectedMarkup,
      4,
    );
    const ledger = await affiliateEarningLedger(affiliateUserId);
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].amount)).toBeCloseTo(collectedMarkup, 4);
  });
});
