/**
 * Regression test for #12994 (the #11588 class on POST /api/v1/messages).
 *
 * The billing `requestId` feeds the affiliate-earnings dedupe sourceId
 * (`getAffiliateEarningsSourceId` → `ai_billing:<op>:<requestId>`, deduped on
 * `addEarnings`) while the org charge is unconditional. Before #12994 the
 * route derived it from the client-controllable request idempotency key:
 *
 *   const requestId = getRequestIdempotencyKey() ?? crypto.randomUUID();
 *
 * so a caller pinning `Idempotency-Key`/`X-Request-Id` across two REAL billed
 * requests suppressed the second cashable affiliate/creator credit while both
 * org charges landed. #12994 server-generates it (mirroring the
 * chat/completions fix for #11588).
 *
 * These tests drive the REAL route handler (`app.request`, not the internal
 * test hooks) with the request-context ALS populated exactly the way the
 * bootstrap populates it from those headers, and assert on the billUsage
 * context — the seam whose `requestId` becomes the affiliate dedupe key:
 *
 *   1. The billed requestId is a server-generated uuid, NOT the pinned client
 *      key (pre-#12994 this assertion fails: requestId === pinned key).
 *   2. Two distinct billed requests pinning the SAME client key get DIFFERENT
 *      billing requestIds — each request's affiliate leg accrues.
 *   3. The client retry key is still readable via getRequestIdempotencyKey()
 *      (positive control: the ALS was populated, so the old code path WOULD
 *      have picked the pinned key — the route now ignores it by design; the
 *      #10423 reservation semantics on the app-credits path are unchanged).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Spread the real modules: bun's `mock.module` replaces the registry entry
// process-wide, so dropping the other real exports would strand later test
// files importing from these modules; afterAll restores them.
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as languageModelActual from "@/lib/providers/language-model";
// REAL request-context module (same ALS instance the route reads).
import {
  getRequestIdempotencyKey,
  runWithRequestContext,
} from "@/lib/runtime/request-context";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as inferenceAuthContextActual from "@/lib/services/inference-auth-context";

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const PINNED_CLIENT_KEY = "req-pinned-by-client-12994";
const AFFILIATE_CODE = "PARTNER1";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// --- auth: resolve straight to an authorized org user (org-credits branch) ---
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthContextActual,
  resolveInferenceAuthContext: async () => ({
    kind: "authorized",
    ctx: { userId: USER, orgId: ORG, apiKeyId: API_KEY_ID },
  }),
}));

// Rate limit: pass-through (the middleware's store is not under test).
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

// Moderation: not under test.
mock.module("@/lib/services/content-moderation", () => ({
  ...contentModerationActual,
  contentModerationService: {
    ...contentModerationActual.contentModerationService,
    shouldBlockUser: async () => false,
    moderateInBackground: () => {},
  },
}));

// Provider config: the model object is unused (generateText is stubbed).
mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getLanguageModel: () => ({}) as never,
}));

// --- billing seam: billUsage is the observation point ------------------------
const billUsage = mock(
  async (_context: { requestId?: string }, _usage: unknown) => ({
    inputCost: 0.001,
    outputCost: 0.001,
    totalCost: 0.002,
    baseInputCost: 0.001,
    baseOutputCost: 0.001,
    baseTotalCost: 0.002,
    platformMarkup: 0,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    markupApplied: true,
  }),
);
const recordUsageAnalytics = mock(async () => ({ id: "usage-1" }));
// The route wraps this reservation in the REAL createCreditReservationSettler
// (deliberately NOT mocked — the abort suite in this package tests the real
// settler, and a process-wide module mock here would strand it); reconcile is
// the only member the settler touches.
const reserveCredits = mock(async () => ({
  reservedAmount: 0.015,
  reconcile: async () => null,
}));
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  billUsage,
  recordUsageAnalytics,
  reserveCredits,
}));

// Model call: succeed immediately so handleNonStream reaches billUsage.
mock.module("ai", () => ({
  ...aiActual,
  generateText: async () => ({
    text: "pong",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    toolCalls: [],
    finishReason: "stop",
    rawFinishReason: undefined,
  }),
}));

// Import the route AFTER the mocks so it binds to the stubs.
const { default: app } = await import("../v1/messages/route");

afterAll(() => {
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthContextActual,
  );
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module(
    "@/lib/services/content-moderation",
    () => contentModerationActual,
  );
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module("ai", () => aiActual);
});

/**
 * One non-streaming /v1/messages request with the client-pinnable headers set
 * AND the request-context ALS populated from them — exactly what the Cloud API
 * bootstrap does upstream of this sub-app. Returns the billUsage context.
 */
async function driveOnce(): Promise<{ requestId?: string } | undefined> {
  const before = billUsage.mock.calls.length;
  const response = await runWithRequestContext(
    { idempotencyKey: PINNED_CLIENT_KEY },
    async () => {
      // POSITIVE control: the retry key IS visible to the route — the old
      // `getRequestIdempotencyKey() ?? crypto.randomUUID()` would pick it up.
      expect(getRequestIdempotencyKey()).toBe(PINNED_CLIENT_KEY);
      return await app.request("/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": PINNED_CLIENT_KEY,
          "idempotency-key": PINNED_CLIENT_KEY,
          "x-affiliate-code": AFFILIATE_CODE,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 32,
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        }),
      });
    },
  );
  // POSITIVE: the billed path completed (not an early 4xx/5xx bail).
  expect(response.status).toBe(200);
  expect(billUsage.mock.calls.length).toBe(before + 1);
  const call = billUsage.mock.calls[before] as unknown as
    | [{ requestId?: string; affiliateCode?: string | null }, unknown]
    | undefined;
  return call?.[0];
}

describe("/v1/messages billing requestId is server-generated (#12994, #11588 class)", () => {
  beforeEach(() => {
    billUsage.mockClear();
    recordUsageAnalytics.mockClear();
    reserveCredits.mockClear();
  });

  test("billed requestId is a fresh uuid, not the client-pinned idempotency key", async () => {
    const ctx = await driveOnce();
    expect(ctx).toBeDefined();
    if (!ctx) throw new Error("billUsage was not called");

    expect(ctx.requestId).toMatch(UUID_RE);
    expect(ctx.requestId).not.toBe(PINNED_CLIENT_KEY);
    // The affiliate leg is in play — this requestId IS the earnings dedupe key.
    expect((ctx as { affiliateCode?: string | null }).affiliateCode).toBe(
      AFFILIATE_CODE,
    );
  });

  test("two billed requests pinning the SAME client key get DIFFERENT billing requestIds", async () => {
    const first = await driveOnce();
    const second = await driveOnce();
    expect(first?.requestId).toMatch(UUID_RE);
    expect(second?.requestId).toMatch(UUID_RE);
    // Pre-#12994 both equaled PINNED_CLIENT_KEY → the second request's
    // cashable affiliate credit deduped away while its org charge landed.
    expect(second?.requestId).not.toBe(first?.requestId);
  });
});
