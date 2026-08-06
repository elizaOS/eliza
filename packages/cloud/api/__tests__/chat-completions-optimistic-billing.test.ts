/**
 * Route-level regression coverage for cache-only organization admission in
 * POST /api/v1/chat/completions. It proves Worker lifetime reaches the central
 * service while route code never invokes legacy storage; service tests own policy.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
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
import * as organizationAdmissionActual from "@/lib/services/organization-inference-admission";
import * as teamPoolActual from "@/lib/services/team-credential-pool";
import * as creditReservationActual from "@/lib/utils/credit-reservation";

const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const CLIENT_REQUEST_ID = "req-optimistic-test";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Legacy billing doubles remain configurable so they can act as tripwires:
// central admission is the only supported route-level entry point.
let billingEnabled = true;
let backstopAvailable = true;
let gateBalanceUsd = 100;
let thresholdUsd = 5;
let backstopPersists = true;
let billingLedger: "kv" | "db" = "kv";
let deferredEnabled = false;
let ledgerAdmits = true;
let reserveCreditsThrows: Error | null = null;
let organizationAdmissionError: Error | null = null;

// Direct storage operations are deliberately observable but must remain unused.
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
const organizationSettler = mock(async (_actualCostUsd: number) => null);
const organizationUnknownSettler = mock(async () => null);
type OrganizationAdmissionParams = Parameters<
  typeof organizationAdmissionActual.admitOrganizationInference
>[0];
const admitOrganizationInference = mock(
  async (params: OrganizationAdmissionParams) => {
    if (organizationAdmissionError) throw organizationAdmissionError;
    return {
      mode: params.executionCtx
        ? ("deferred_kv_ledger" as const)
        : ("synchronous_reservation" as const),
      settle: organizationSettler,
      settleUnknown: organizationUnknownSettler,
    };
  },
);
const enforceOrgRateLimit = mock(async () => null);

// Auth: resolve straight to an authorized org user via the hot-path resolver so
// the org-credits branch (not app-credits) is taken and moderation is skipped.
type AuthResolveOptions = NonNullable<
  Parameters<typeof inferenceAuthContextActual.resolveInferenceAuthContext>[1]
>;
const authResolveOptions: AuthResolveOptions[] = [];
// IAC v2 (#17805): the cached identity carries the admission projection —
// balance plus per-endpoint rate policy — so the route derives its limiter
// config from the single auth cache read instead of a per-route native gate.
const ADMISSION = {
  balance: { balanceUsd: 100, balanceAt: 1, balanceRevision: "1" },
  rateLimits: {
    completionsRpm: 60,
    embeddingsRpm: 100,
    standardRpm: 30,
    strictRpm: 5,
  },
};
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
        v: 2 as const,
        cachedAt: Date.now(),
        userId: USER,
        orgId: ORG,
        apiKeyId: API_KEY_ID,
        keyHash: "a".repeat(64),
        appScopeId: null,
        admission: ADMISSION,
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
  getGatewayModelByIdCacheOnly: async () => ({
    kind: "ready",
    model: null,
    stale: false,
  }),
}));

// Pooled-credential selection is not under test. Keep this route harness away
// from the DB-backed team pool registry so billing-path assertions remain the
// only observation point.
mock.module("@/lib/services/team-credential-pool", () => ({
  ...teamPoolActual,
  getTeamPoolRegistry: () => ({
    selectCredential: async () => null,
    selectCredentialCacheOnly: async () => ({
      kind: "ready",
      credential: null,
    }),
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

// These legacy service doubles are tripwires for accidental route-level
// storage calls. Admission policy itself is covered by its service suite.
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

// Preserve the real deferred-state helpers used by other imported modules.
mock.module("@/lib/services/inference-billing-deferred", () => ({
  ...billingDeferredActual,
  isDeferredAdmissionEnabled: () => deferredEnabled,
}));

mock.module("@/lib/services/organization-inference-admission", () => ({
  ...organizationAdmissionActual,
  admitOrganizationInference,
}));

mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit,
}));

// A direct synchronous reserve from this route is forbidden on the Worker path.
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
  mock.module(
    "@/lib/services/organization-inference-admission",
    () => organizationAdmissionActual,
  );
  mock.module("@/lib/middleware/rate-limit", () => rateLimitActual);
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

describe("chat/completions cache-only organization admission", () => {
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
    organizationAdmissionError = null;
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
    admitOrganizationInference.mockClear();
    organizationSettler.mockClear();
    organizationUnknownSettler.mockClear();
    enforceOrgRateLimit.mockClear();
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
    expect(admitOrganizationInference).toHaveBeenCalledTimes(1);
    expect(reserveCredits).not.toHaveBeenCalled();
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
    expect(organizationUnknownSettler).toHaveBeenCalled();
  });

  test("delegates organization billing once without calling legacy storage primitives", async () => {
    await drive();

    expect(admitOrganizationInference).toHaveBeenCalledTimes(1);
    const admission = (
      admitOrganizationInference.mock.calls as unknown as Array<
        [OrganizationAdmissionParams]
      >
    )[0]?.[0];
    expect(admission).toMatchObject({
      context: {
        organizationId: ORG,
        userId: USER,
        apiKeyId: API_KEY_ID,
        model: "gpt-4o-mini",
      },
      apiKeyId: API_KEY_ID,
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("the Worker lane reaches the handler with snapshot-derived org rate limiting and no per-route native gate", async () => {
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

    // The model stub throws after dispatch. A 500 here proves the request
    // entered the same real route handler exercised below.
    expect(response.status).toBe(500);
    // #17805 removed the per-route native Cloudflare gate from the hot path:
    // the binding must never be consulted and its policy header never set.
    // Rate limiting is now the org-level check fed by the admission snapshot
    // carried in the single auth cache read.
    expect(keys).toEqual([]);
    expect(response.headers.get("X-RateLimit-Policy")).toBeNull();
    expect(authResolveOptions).toHaveLength(1);
    expect(authResolveOptions[0]?.executionCtx).toBeDefined();
    expect(authResolveOptions[0]?.cacheOnly).toBe(true);
    expect(enforceOrgRateLimit).toHaveBeenCalledWith(
      ORG,
      "completions",
      expect.objectContaining({
        cacheOnly: true,
        executionCtx: expect.any(Object),
        config: {
          windowMs: 60_000,
          maxRequests: ADMISSION.rateLimits.completionsRpm,
        },
      }),
    );
    expect(response.headers.get("X-Eliza-Auth-Trace")).toContain(
      "result=authorized_cache",
    );
    expect(response.headers.get("Server-Timing")).toContain(
      "auth_resolve;dur=1.2",
    );
    expect(generateText).toHaveBeenCalledTimes(1);
    await Promise.all(waitUntilPromises);
    expect(admitOrganizationInference).toHaveBeenCalledTimes(1);
    const admission = (
      admitOrganizationInference.mock.calls as unknown as Array<
        [OrganizationAdmissionParams]
      >
    )[0]?.[0];
    expect(admission?.executionCtx).toBeDefined();
    expect(organizationUnknownSettler).toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
  });

  test("billing requestId is server-generated, not copied from x-request-id", async () => {
    await drive();

    const admission = (
      admitOrganizationInference.mock.calls as unknown as Array<
        [OrganizationAdmissionParams]
      >
    )[0]?.[0];
    expect(admission).toBeDefined();
    if (!admission) throw new Error("billing path was not reached");

    expect(admission.context.requestId).toMatch(UUID_RE);
    expect(admission.context.requestId).not.toBe(CLIENT_REQUEST_ID);
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
    expect(admitOrganizationInference).not.toHaveBeenCalled();
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
    expect(admitOrganizationInference).toHaveBeenCalledTimes(1);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 512,
      providerOptions: { openai: { reasoningEffort: "none" } },
    });
  });

  test("non-Worker compatibility delegates storage policy to the admission service", async () => {
    const response = await drive();

    expect(response.status).toBe(500);
    expect(admitOrganizationInference).toHaveBeenCalledTimes(1);
    const admission = (
      admitOrganizationInference.mock.calls as unknown as Array<
        [OrganizationAdmissionParams]
      >
    )[0]?.[0];
    expect(admission?.executionCtx).toBeUndefined();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
  });

  test("Worker requests pass their lifetime into cache-only admission and never call legacy DB fallbacks", async () => {
    const captured: Promise<unknown>[] = [];
    const response = await driveWithCtx(captured);

    expect(response.status).toBe(500);
    const admission = (
      admitOrganizationInference.mock.calls as unknown as Array<
        [OrganizationAdmissionParams]
      >
    )[0]?.[0];
    expect(admission?.executionCtx).toBeDefined();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
    await Promise.all(captured);
    expect(organizationUnknownSettler).toHaveBeenCalled();
  });

  test("a cold billing cache returns retryable 503 before provider dispatch or DB fallback", async () => {
    organizationAdmissionError =
      new fastPathActual.InferenceBalanceCacheWarmingError();
    const captured: Promise<unknown>[] = [];

    const response = await driveWithCtx(captured);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "billing_cache_warming" },
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
  });

  test("a cached insufficient-balance decision returns 402 without provider dispatch or DB fallback", async () => {
    organizationAdmissionError = new aiBillingActual.InsufficientCreditsError(
      0.05,
      0.01,
    );
    const captured: Promise<unknown>[] = [];

    const response = await driveWithCtx(captured);

    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "insufficient_credits" },
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    expect(admitInferenceChargeViaLedger).not.toHaveBeenCalled();
  });

  test("affiliate attribution remains part of the same Worker cache-only admission call", async () => {
    const captured: Promise<unknown>[] = [];
    await handleChatCompletionsPOST(makeRequest("PARTNER1000"), {
      skipOrgRateLimit: true,
      executionCtx: { waitUntil: (promise) => captured.push(promise) },
    });

    const admission = (
      admitOrganizationInference.mock.calls as unknown as Array<
        [OrganizationAdmissionParams]
      >
    )[0]?.[0];
    expect(admission).toMatchObject({
      affiliateCode: "PARTNER1000",
      context: { affiliateCode: "PARTNER1000" },
      executionCtx: expect.any(Object),
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(writePendingInferenceCharge).not.toHaveBeenCalled();
    await Promise.all(captured);
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
