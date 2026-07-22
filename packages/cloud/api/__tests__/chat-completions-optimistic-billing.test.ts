/**
 * Route-level regression tests for the Tier-2 optimistic-billing DECISION in
 * POST /api/v1/chat/completions (#9899 / #10026, activated in prod by #10066).
 *
 * The optimistic-billing SERVICE layer (eligibility math, exactly-once settle,
 * sweep) is covered by `inference-billing-fast-path.test.ts`. What was NOT
 * covered is the ROUTE's orchestration of those functions — the part the prod
 * flag flip actually turns on:
 *
 *   gate (hot-path && flag && backstop-writable) → eligibility → write the
 *   durable backstop → only on a durable write take the optimistic path;
 *   otherwise fall back to the synchronous credit reserve.
 *
 * These tests drive the REAL `handleChatCompletionsPOST` through that decision
 * with the REAL `isOptimisticEligible` (the load-bearing predicate). Only the
 * env-gates, the gate-balance read, the backstop write, and the synchronous
 * reserve are mocked at the module boundary so we can (a) control the inputs and
 * (b) prove which billing path the route chose. The model call (`generateText`)
 * is stubbed to throw immediately AFTER the decision, so the route returns an
 * error response while the billing path has already been chosen — the spies are
 * the observation point, not the response.
 *
 * Invariants pinned (each has a POSITIVE assertion so an early bail before the
 * decision can't make a negative-only test pass):
 *   1. Eligible org → optimistic path: backstop written, synchronous reserve
 *      SKIPPED, optimistic settler wired.
 *   2. Balance below SAFE_BALANCE_THRESHOLD → synchronous reserve (no backstop).
 *   3. Backstop not writable (cache down) → synchronous reserve, never forwards
 *      on an un-recorded charge (#9899 free-inference hole).
 *   4. Flag OFF → synchronous reserve (default-safe).
 *   5. Non-durable backstop write → fall back to synchronous reserve (backstop
 *      attempted, optimistic settler NOT wired).
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as pricingActual from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
// Spread the real modules: bun's `mock.module` replaces the registry entry
// process-wide, so dropping the other real exports would strand later test
// files importing from these modules; afterAll restores them.
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as inferenceAuthContextActual from "@/lib/services/inference-auth-context";
import * as billingDeferredActual from "@/lib/services/inference-billing-deferred";
import * as fastPathActual from "@/lib/services/inference-billing-fast-path";
import * as billingLedgerActual from "@/lib/services/inference-billing-ledger";
import * as modelCatalogActual from "@/lib/services/model-catalog";
import * as teamPoolActual from "@/lib/services/team-credential-pool";
import * as creditReservationActual from "@/lib/utils/credit-reservation";

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const CLIENT_REQUEST_ID = "req-optimistic-test";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// --- per-test knobs the mocks read by reference -----------------------------
let billingEnabled = true;
let backstopAvailable = true;
let gateBalanceUsd = 100;
let thresholdUsd = 5;
let backstopPersists = true;
let billingLedger: "kv" | "db" = "kv";
let deferredEnabled = false;
let ledgerAdmits = true;
let reserveCreditsThrows: Error | null = null;

// --- spies on the two terminal billing paths --------------------------------
const writePendingInferenceCharge = mock(async () => backstopPersists);
const reserveCredits = mock(async () => {
  if (reserveCreditsThrows) throw reserveCreditsThrows;
  return {
    reservedAmount: 0.015,
    // not exercised — createCreditReservationSettler is stubbed to a no-op below
    reconcile: async () => null,
  };
});
// Inner settlers are spies too so the Tier-3 tests can prove the settle chain
// reaches the exactly-once settler AFTER the deferred admission resolves.
const optimisticInnerSettler = mock(async (_actualCost: number) => null);
const ledgerInnerSettler = mock(async (_actualCost: number) => null);
const createOptimisticDebitSettler = mock(() => optimisticInnerSettler);
const admitInferenceChargeViaLedger = mock(async () => ({
  admitted: ledgerAdmits,
}));
const createLedgerDebitSettler = mock(() => ledgerInnerSettler);
const createCreditReservationSettler = mock(() => async () => null);

// Auth: resolve straight to an authorized org user via the hot-path resolver so
// the org-credits branch (not app-credits) is taken and moderation is skipped.
type AuthResolveOptions = NonNullable<
  Parameters<typeof inferenceAuthContextActual.resolveInferenceAuthContext>[1]
>;
const authResolveOptions: AuthResolveOptions[] = [];
const resolveInferenceAuthContext = mock(
  async (_request: Request, options: AuthResolveOptions = {}) => {
    authResolveOptions.push(options);
    options.onTelemetry?.({
      v: 1,
      traceId: "11111111-1111-4111-8111-111111111111",
      authSource: "x_api_key",
      controlledProbe: "off",
      cacheAvailability: "available",
      cacheBackend: "cloudflare_kv",
      cacheRead: "hit",
      authoritative: "not_run",
      cacheWrite: "not_run",
      result: "authorized_cache",
      timings: {
        extractMs: 0.1,
        cacheAvailabilityMs: 0.1,
        cacheReadMs: 1,
        keyLookupMs: null,
        userOrgLookupMs: null,
        moderationMs: null,
        cacheWriteMs: null,
        totalMs: 1.2,
      },
    });
    return {
      kind: "authorized" as const,
      source: "cache" as const,
      ctx: {
        v: 1 as const,
        cachedAt: Date.now(),
        userId: USER,
        orgId: ORG,
        apiKeyId: API_KEY_ID,
        keyHash: "a".repeat(64),
      },
    };
  },
);
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthContextActual,
  isInferenceHotPathCacheEnabled: () => true,
  resolveInferenceAuthContext,
}));

// Provider config: pretend a provider is configured; the model object is unused
// because the model call is stubbed.
mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  hasLanguageModelProviderConfigured: () => true,
  getLanguageModel: () => ({}) as never,
}));

// Cost: the optimistic gate computes an estimate; a tiny fixed cost keeps the
// org comfortably above it so eligibility turns only on the balance/threshold.
mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost: async () => ({
    totalCost: 0.01,
    inputCost: 0.005,
    outputCost: 0.005,
  }),
}));

// Reasoning-detection catalog read is best-effort; make it a no-op miss.
mock.module("@/lib/services/model-catalog", () => ({
  ...modelCatalogActual,
  getCachedGatewayModelById: async () => null,
}));

// Pooled-credential selection is not under test. Keep this route harness away
// from the DB-backed team pool registry so billing-path assertions remain the
// only observation point.
mock.module("@/lib/services/team-credential-pool", () => ({
  ...teamPoolActual,
  getTeamPoolRegistry: () => ({
    selectCredential: async () => null,
    recordUse: async () => undefined,
    recordProviderFailure: async () => undefined,
  }),
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

// The component under test is the ROUTE's orchestration + the REAL
// isOptimisticEligible. Env-gates, the balance read, the backstop write and the
// optimistic settler factory are controlled/spied; isOptimisticEligible is left
// REAL (spread).
mock.module("@/lib/services/inference-billing-fast-path", () => ({
  ...fastPathActual,
  isOptimisticBillingEnabled: () => billingEnabled,
  isOptimisticBackstopAvailable: () => backstopAvailable,
  getGateBalanceUsd: async () => gateBalanceUsd,
  resolveSafeBalanceThresholdUsd: () => thresholdUsd,
  writePendingInferenceCharge,
  createOptimisticDebitSettler,
}));

mock.module("@/lib/services/inference-billing-ledger", () => ({
  ...billingLedgerActual,
  resolveInferenceBillingLedger: () => billingLedger,
  admitInferenceChargeViaLedger,
  createLedgerDebitSettler,
}));

// Tier-3 deferred admission: only the env flag is a knob — the settler and the
// refusal blocklist stay REAL (they are part of what is under test).
mock.module("@/lib/services/inference-billing-deferred", () => ({
  ...billingDeferredActual,
  isDeferredAdmissionEnabled: () => deferredEnabled,
}));

// Synchronous reserve path — spied so we can prove it is the fallback.
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  reserveCredits,
}));

// Settler factory for the reserve path — stub to a no-op so the post-response
// settle in the catch block needs no ledger.
mock.module("@/lib/utils/credit-reservation", () => ({
  ...creditReservationActual,
  createCreditReservationSettler,
}));

// Stub the model call so the handler returns right after the billing decision.
// Keep spies so reasoning-effort tests can also assert the exact configuration
// that survives the full route pipeline.
const generateText = mock((_config: Record<string, unknown>) => {
  throw new Error("model-call-stub");
});
const streamText = mock((_config: Record<string, unknown>) => {
  throw new Error("model-call-stub");
});
mock.module("ai", () => ({
  ...aiActual,
  generateText,
  streamText,
}));

// Import the route AFTER the mocks so it binds to the stubs.
const { default: chatCompletionsRouter, handleChatCompletionsPOST } =
  await import("../v1/chat/completions/route");
const { __responsesRouteTestHooks } = await import("../v1/responses/route");
const { buildChatRequest, mapChatCompletionToResponse, toChatMessages } =
  __responsesRouteTestHooks;

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthContextActual,
  );
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/pricing", () => pricingActual);
  mock.module("@/lib/services/model-catalog", () => modelCatalogActual);
  mock.module("@/lib/services/team-credential-pool", () => teamPoolActual);
  mock.module(
    "@/lib/services/content-moderation",
    () => contentModerationActual,
  );
  mock.module(
    "@/lib/services/inference-billing-fast-path",
    () => fastPathActual,
  );
  mock.module(
    "@/lib/services/inference-billing-ledger",
    () => billingLedgerActual,
  );
  mock.module(
    "@/lib/services/inference-billing-deferred",
    () => billingDeferredActual,
  );
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module("@/lib/utils/credit-reservation", () => creditReservationActual);
});

function makeRequest(
  affiliateCode?: string,
  overrides: Record<string, unknown> = {},
  url = "https://api.test/api/v1/chat/completions",
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": CLIENT_REQUEST_ID,
      "x-eliza-trace-id": "11111111-1111-4111-8111-111111111111",
      ...(affiliateCode ? { "X-Affiliate-Code": affiliateCode } : {}),
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      ...overrides,
    }),
  });
}

async function drive(affiliateCode?: string): Promise<Response> {
  // The handler owns its try/catch and always returns a Response (the stubbed
  // model call makes it an error response); we only read the spies.
  return await handleChatCompletionsPOST(makeRequest(affiliateCode), {
    skipOrgRateLimit: true,
  });
}

/** Tier-3 driver: same as `drive` but with a captured Workers executionCtx. */
async function driveWithCtx(captured: Promise<unknown>[]): Promise<Response> {
  return await handleChatCompletionsPOST(makeRequest(), {
    skipOrgRateLimit: true,
    executionCtx: {
      waitUntil: (p: Promise<unknown>) => {
        captured.push(p);
      },
    },
  });
}

describe("chat/completions optimistic-billing route decision (#9899/#10066)", () => {
  beforeEach(() => {
    billingEnabled = true;
    backstopAvailable = true;
    gateBalanceUsd = 100;
    thresholdUsd = 5;
    backstopPersists = true;
    billingLedger = "kv";
    deferredEnabled = false;
    ledgerAdmits = true;
    reserveCreditsThrows = null;
    billingDeferredActual.__clearDeferredAdmissionState();
    writePendingInferenceCharge.mockClear();
    reserveCredits.mockClear();
    createOptimisticDebitSettler.mockClear();
    optimisticInnerSettler.mockClear();
    admitInferenceChargeViaLedger.mockClear();
    createLedgerDebitSettler.mockClear();
    ledgerInnerSettler.mockClear();
    createCreditReservationSettler.mockClear();
    authResolveOptions.length = 0;
    resolveInferenceAuthContext.mockClear();
    generateText.mockClear();
    streamText.mockClear();
  });

  test("forwards the prompt cache key through the full Cerebras route", async () => {
    await handleChatCompletionsPOST(
      makeRequest(undefined, {
        model: "gpt-oss-120b",
        prompt_cache_key: "v5:optimistic-route",
      }),
      { skipOrgRateLimit: true },
    );

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      providerOptions: {
        openai: { promptCacheKey: "v5:optimistic-route" },
      },
    });
  });

  test("provider errors preserve the exact frozen preforward boundary", async () => {
    const response = await drive();

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers.get("X-Eliza-Trace-Id")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    const preforward = response.headers.get("X-Eliza-Preforward-Ms");
    expect(preforward).toMatch(
      /^total=\d+(?:\.\d+)?;auth=\d+(?:\.\d+)?;mid=\d+(?:\.\d+)?;reserve=\d+(?:\.\d+)?;setup=\d+(?:\.\d+)?$/,
    );
    expect(response.headers.get("Server-Timing")).toContain(
      "gateway_preforward;dur=",
    );
  });

  test("eligible org takes the optimistic path: writes backstop, skips the synchronous reserve", async () => {
    await drive();
    // POSITIVE: the decision was reached and chose optimistic.
    expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
    expect(createOptimisticDebitSettler).toHaveBeenCalledTimes(1);
    // The synchronous reserve write (the latency we are removing) is skipped.
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  test("an allowed native route decision reaches the handler and preserves limiter headers", async () => {
    const keys: string[] = [];
    const waitUntilPromises: Promise<unknown>[] = [];
    const response = await chatCompletionsRouter.fetch(
      makeRequest(undefined, {}, "https://api.test/"),
      {
        NODE_ENV: "production",
        CHAT_ROUTE_RATE_LIMITER: {
          async limit({ key }: { key: string }) {
            keys.push(key);
            return { success: true };
          },
        },
      } as never,
      {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
        passThroughOnException() {},
        props: {},
      } as never,
    );

    // The model stub throws after dispatch. A 500 here proves the native gate
    // allowed the request into the same real route handler exercised below.
    expect(response.status).toBe(500);
    expect(keys).toEqual(["public"]);
    expect(response.headers.get("X-RateLimit-Policy")).toBe(
      "cloudflare-native",
    );
    expect(authResolveOptions).toHaveLength(1);
    expect(authResolveOptions[0]?.executionCtx).toBeDefined();
    expect(response.headers.get("X-Eliza-Auth-Trace")).toContain(
      "result=authorized_cache",
    );
    expect(response.headers.get("Server-Timing")).toContain(
      "auth_resolve;dur=1.2",
    );
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntilPromises);
  });

  test("billing requestId is server-generated, not copied from x-request-id", async () => {
    await drive();

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

  test("invalid Cerebras reasoning_effort is rejected before billing or provider dispatch", async () => {
    const res = await handleChatCompletionsPOST(
      makeRequest(undefined, {
        model: "openai/gpt-oss-120b:nitro",
        reasoning_effort: "none",
        max_tokens: 512,
      }),
      { skipOrgRateLimit: true },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        message:
          "reasoning_effort for model 'gpt-oss-120b' must be one of: low, medium, high",
        type: "invalid_request_error",
        code: "invalid_reasoning_effort",
      },
    });
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("valid GLM reasoning_effort=none preserves max_tokens through the full route", async () => {
    const res = await handleChatCompletionsPOST(
      makeRequest(undefined, {
        model: "zai-glm-4.7",
        reasoning_effort: "none",
        max_tokens: 512,
      }),
      { skipOrgRateLimit: true },
    );

    // The model stub throws after dispatch; reaching it proves the request
    // passed route validation and billing without silently changing the cap.
    expect(res.status).toBe(500);
    expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 512,
      providerOptions: { openai: { reasoningEffort: "none" } },
    });
  });

  test("balance below SAFE_BALANCE_THRESHOLD falls back to the synchronous reserve", async () => {
    gateBalanceUsd = 2; // < threshold 5 → not eligible
    await drive();
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(createOptimisticDebitSettler).not.toHaveBeenCalled();
  });

  test("backstop not writable (cache down) falls back to the synchronous reserve", async () => {
    backstopAvailable = false; // gate fails before eligibility
    await drive();
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  });

  test("optimistic billing flag OFF takes the synchronous reserve (default-safe)", async () => {
    billingEnabled = false;
    await drive();
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  });

  test("non-durable backstop write falls back to the synchronous reserve (never forwards un-recorded)", async () => {
    backstopPersists = false; // eligible + write attempted, but not durable
    await drive();
    // POSITIVE: the backstop write was attempted (decision chose optimistic)...
    expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
    // ...but a non-durable write must fall through to the synchronous reserve.
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(createOptimisticDebitSettler).not.toHaveBeenCalled();
  });

  test("X-Affiliate-Code forces the synchronous reserve even when the KV optimistic path is eligible (#12749)", async () => {
    await drive("PARTNER1000");

    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(createOptimisticDebitSettler).not.toHaveBeenCalled();
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    const reserveCalls = reserveCredits.mock.calls as unknown as Array<
      [{ affiliateCode?: string | null }]
    >;
    expect(reserveCalls[0]?.[0]?.affiliateCode).toBe("PARTNER1000");
  });

  test("X-Affiliate-Code also bypasses the DB-ledger optimistic branch (#12749)", async () => {
    billingLedger = "db";

    await drive();
    expect(admitInferenceChargeViaLedger).toHaveBeenCalledTimes(1);
    expect(createLedgerDebitSettler).toHaveBeenCalledTimes(1);
    expect(reserveCredits).not.toHaveBeenCalled();

    admitInferenceChargeViaLedger.mockClear();
    createLedgerDebitSettler.mockClear();
    reserveCredits.mockClear();

    await drive("PARTNER1000");

    expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
    expect(createLedgerDebitSettler).not.toHaveBeenCalled();
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    const reserveCalls = reserveCredits.mock.calls as unknown as Array<
      [{ affiliateCode?: string | null }]
    >;
    expect(reserveCalls[0]?.[0]?.affiliateCode).toBe("PARTNER1000");
  });

  describe("Tier-3 deferred admission (#9899)", () => {
    test("KV backend: admission moves to waitUntil, warm path does no synchronous reserve, settle chain still reaches the exactly-once settler", async () => {
      deferredEnabled = true;
      const captured: Promise<unknown>[] = [];

      await driveWithCtx(captured);

      // The durable write was started and handed to waitUntil — not awaited on
      // the critical path (the critical path only read the cached gate).
      expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(1);
      await expect(captured[0]).resolves.toEqual({ admitted: true });
      // No synchronous reserve.
      expect(reserveCredits).not.toHaveBeenCalled();
      // The route's error path settled with 0 THROUGH the deferred settler,
      // which awaited the admission then delegated to the exactly-once KV
      // settler — reconciliation semantics preserved.
      expect(createOptimisticDebitSettler).toHaveBeenCalledTimes(1);
      expect(optimisticInnerSettler).toHaveBeenCalledTimes(1);
      expect(optimisticInnerSettler).toHaveBeenCalledWith(0);
    });

    test("DB ledger backend: ledger admission is the deferred producer; ledger settler still settles", async () => {
      deferredEnabled = true;
      billingLedger = "db";
      const captured: Promise<unknown>[] = [];

      await driveWithCtx(captured);

      expect(admitInferenceChargeViaLedger).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(1);
      await expect(captured[0]).resolves.toEqual({ admitted: true });
      expect(reserveCredits).not.toHaveBeenCalled();
      expect(createLedgerDebitSettler).toHaveBeenCalledTimes(1);
      expect(ledgerInnerSettler).toHaveBeenCalledTimes(1);
      expect(ledgerInnerSettler).toHaveBeenCalledWith(0);
      // The KV backstop was never touched on the db backend.
      expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    });

    test("no executionCtx → deferred path is inert; Tier-2 synchronous admission behavior is unchanged", async () => {
      deferredEnabled = true;
      await drive(); // no executionCtx
      // Tier-2 KV branch ran (backstop written, optimistic settler wired) but
      // nothing was handed to waitUntil — the admission was awaited inline.
      expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
      expect(createOptimisticDebitSettler).toHaveBeenCalledTimes(1);
      expect(reserveCredits).not.toHaveBeenCalled();
    });

    test("402 still fires: a cached balance below threshold falls to the synchronous reserve and surfaces insufficient_credits", async () => {
      deferredEnabled = true;
      gateBalanceUsd = 2; // < threshold 5 → cached gate refuses the deferred path
      const { InsufficientCreditsError } = await import(
        "@/lib/services/ai-billing"
      );
      reserveCreditsThrows = new InsufficientCreditsError(0.05, 0.01);
      const captured: Promise<unknown>[] = [];

      const res = await driveWithCtx(captured);

      expect(captured).toHaveLength(0); // nothing deferred for a broke org
      expect(reserveCredits).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(402);
      const body = (await res.json()) as {
        error?: { code?: string; type?: string };
      };
      expect(body.error?.code).toBe("insufficient_credits");
    });

    test("a refused deferred admission blocklists the org: the NEXT request takes the synchronous reserve", async () => {
      deferredEnabled = true;
      backstopPersists = false; // deferred KV admission resolves { admitted: false }
      const captured: Promise<unknown>[] = [];

      await driveWithCtx(captured);
      // First request took the deferred path (write attempted via waitUntil)…
      expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(1);
      await expect(captured[0]).resolves.toEqual({ admitted: false });
      // …and its settle(0) ran the refusal fallback (no exactly-once settler).
      expect(optimisticInnerSettler).not.toHaveBeenCalled();
      expect(reserveCredits).not.toHaveBeenCalled();

      writePendingInferenceCharge.mockClear();
      await driveWithCtx(captured);
      // Blocklisted org skips the deferred path; the Tier-2 branch attempts the
      // backstop synchronously, and (still non-durable) falls back to the
      // synchronous reserve — never forwards on an un-recorded charge.
      expect(captured).toHaveLength(1);
      expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
      expect(reserveCredits).toHaveBeenCalledTimes(1);
    });

    test("flag OFF leaves the executionCtx-carrying request on the Tier-2 synchronous admission", async () => {
      deferredEnabled = false;
      const captured: Promise<unknown>[] = [];
      await driveWithCtx(captured);
      expect(captured).toHaveLength(0);
      expect(writePendingInferenceCharge).toHaveBeenCalledTimes(1);
      expect(reserveCredits).not.toHaveBeenCalled();
    });
  });
});

describe("responses compatibility transformations", () => {
  test("converts instructions and mixed input parts into chat messages", () => {
    expect(
      toChatMessages({
        instructions: " Be concise. ",
        input: [
          {
            role: "assistant",
            content: [
              { type: "output_text", output_text: " Prior answer " },
              { type: "input_text", input_text: "Additional context" },
            ],
          },
          { role: undefined, content: " Follow up " },
          { role: "tool", content: [] },
        ],
      }),
    ).toEqual([
      { role: "system", content: "Be concise." },
      {
        role: "assistant",
        content: "Prior answer \nAdditional context",
      },
      { role: "user", content: "Follow up" },
    ]);
    expect(toChatMessages({ input: " Hello " })).toEqual([
      { role: "user", content: "Hello" },
    ]);
    expect(toChatMessages({ input: undefined })).toEqual([]);
  });

  test("maps a chat completion without fabricating usage", () => {
    const mapped = mapChatCompletionToResponse(
      {
        id: "resp_existing",
        model: "provider/model",
        choices: [{ message: { content: " Hello from the provider " } }],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      },
      "requested/model",
    );

    expect(mapped).toMatchObject({
      id: "resp_existing",
      object: "response",
      model: "provider/model",
      status: "completed",
      output_text: "Hello from the provider",
      usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
    });
    expect(mapped.output[0]?.content[0]).toEqual({
      type: "output_text",
      text: "Hello from the provider",
    });
  });

  test("builds a non-streaming compatibility request with caller headers", async () => {
    const original = new Request("https://cloud.test/api/v1/responses", {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Length": "999",
        "X-Eliza-Trace-Id": "33333333-3333-4333-8333-333333333333",
      },
      body: "{}",
    });
    const request = buildChatRequest(
      original,
      {
        model: "provider/model",
        temperature: 0.2,
        max_output_tokens: 64,
        top_p: 0.9,
      },
      [{ role: "user", content: "hello" }],
    );

    expect(request.headers.get("Authorization")).toBe("Bearer eliza_test_key");
    expect(request.headers.get("Content-Length")).toBeNull();
    expect(request.headers.get("X-Eliza-Trace-Id")).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    const chatBody = (await request.json()) as Record<string, unknown>;
    expect(chatBody).toEqual({
      model: "provider/model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      max_tokens: 64,
      top_p: 0.9,
      stream: false,
    });
  });
});
