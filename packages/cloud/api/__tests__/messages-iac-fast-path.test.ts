/**
 * Route-level regression coverage for the /v1/messages IAC fast path.
 *
 * The route should use the shared inference-auth resolver for API-key requests,
 * skip the serial Hono auth/API-key lookup and synchronous moderation read on
 * authorized hits, and still return Anthropic-compatible 403s for suspended
 * users before any provider or billing work.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const aiActual = require("ai") as Record<string, unknown>;
const aiBillingActual = { ...(await import("@/lib/services/ai-billing")) };
const creditsActual = { ...(await import("@/lib/services/credits")) };

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";

mock.module("@/lib/pricing", () => ({
  calculateCost: async () => ({
    inputCost: 0.001,
    outputCost: 0.001,
    totalCost: 0.002,
  }),
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  getProviderFromModel: () => "anthropic",
  getSafeModelParams: () => ({}),
  modelUsesReasoningTokens: () => false,
  normalizeModelName: (model: string) => model,
}));

mock.module("@/lib/providers/anthropic-thinking", () => ({
  mergeAnthropicCotProviderOptions: () => ({}),
  resolveAnthropicThinkingBudgetTokens: () => null,
}));

const resolveInferenceAuthContext = mock();
mock.module("@/lib/services/inference-auth-context", () => ({
  resolveInferenceAuthContext,
}));

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

const validateApiKey = mock();
mock.module("@/lib/services/api-keys", () => ({
  apiKeysService: {
    validateApiKey,
  },
}));

const shouldBlockUser = mock();
const moderateInBackground = mock();
mock.module("@/lib/services/content-moderation", () => ({
  contentModerationService: {
    shouldBlockUser,
    moderateInBackground,
  },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { RELAXED: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

class TestOrgRateLimitCacheNotReadyError extends Error {}
let orgRateLimitResult: Response | null = null;
let orgRateLimitError: Error | null = null;
const enforceOrgRateLimit = mock(async () => {
  if (orgRateLimitError) throw orgRateLimitError;
  return orgRateLimitResult;
});
mock.module("@/lib/middleware/rate-limit", () => ({
  enforceOrgRateLimit,
  OrgRateLimitCacheNotReadyError: TestOrgRateLimitCacheNotReadyError,
}));

mock.module("@/lib/providers/language-model", () => ({
  canonicalizeCerebrasModelId: (model: string) => model,
  getLanguageModel: () => ({}) as never,
  isProviderConfigurationError: () => false,
  resolveAiProviderSource: () => "bitrouter",
}));

class TestInsufficientCreditsError extends Error {
  required: number;

  constructor(required: number) {
    super("Insufficient credits");
    this.required = required;
  }
}

const reserveCredits = mock();
const billUsage = mock();
const estimateInputTokens = mock();
const recordUsageAnalytics = mock();
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  isSubscriptionFundedOrganization: mock(async () => false),
  InsufficientCreditsError: TestInsufficientCreditsError,
  billUsage,
  estimateInputTokens,
  getAffiliatePayoutSourceId: (context: { requestId?: string | null }) =>
    `affiliate:${context.requestId ?? "missing"}`,
  normalizeUsage: (
    usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
          promptTokens?: number;
          completionTokens?: number;
          cacheReadInputTokens?: number;
          cacheWriteInputTokens?: number;
          cachedInputTokens?: number;
          cacheCreationInputTokens?: number;
        }
      | null
      | undefined,
  ) => {
    const inputTokens = usage?.inputTokens ?? usage?.promptTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? usage?.completionTokens ?? 0;
    return {
      cacheReadInputTokens:
        usage?.cacheReadInputTokens ?? usage?.cachedInputTokens ?? 0,
      cacheWriteInputTokens:
        usage?.cacheWriteInputTokens ?? usage?.cacheCreationInputTokens ?? 0,
      inputTokens,
      outputTokens,
      totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
    };
  },
  recordUsageAnalytics,
  reserveCredits,
  reserveFlatUsageCredits: mock(),
}));

mock.module("@/lib/services/credits", () => ({
  ...creditsActual,
  COST_BUFFER: 1.5,
  InsufficientCreditsError: TestInsufficientCreditsError,
  MIN_RESERVATION: 0.01,
  creditsService: {
    createAnonymousReservation: () => ({
      reservedAmount: 0,
      reconcile: async () => null,
    }),
  },
}));

const reserveInferenceCredits = mock();
mock.module("@/lib/services/app-credits", () => ({
  appCreditsService: {
    calculateCostWithMarkup: async () => ({ totalCost: 0.002 }),
    checkBalance: async () => ({ sufficient: true }),
    reserveInferenceCredits,
    recordUsage: async () => undefined,
  },
}));

const getAuthorizedMonetizedAppForUser = mock();
const getAuthorizedMonetizedAppForUserCacheOnly = mock();
mock.module("@/lib/services/apps", () => ({
  appsService: {
    getAuthorizedMonetizedAppForUser,
    getAuthorizedMonetizedAppForUserCacheOnly,
    getById: async () => null,
  },
}));

const admitAppInferenceCacheOnly = mock();
class TestInferenceAppAffiliateUnsupportedError extends Error {}
const assertInferenceAppAffiliateSupported = mock(
  (_appId: string, affiliateCode: string | null | undefined) => {
    if (affiliateCode?.trim()) {
      throw new TestInferenceAppAffiliateUnsupportedError();
    }
  },
);
mock.module("@/lib/services/app-inference-admission", () => ({
  admitAppInferenceCacheOnly,
  assertInferenceAppAffiliateSupported,
  InferenceAppAffiliateUnsupportedError:
    TestInferenceAppAffiliateUnsupportedError,
}));

const createCreditReservationSettler = mock();
mock.module("@/lib/utils/credit-reservation", () => ({
  createCreditReservationSettler,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

mock.module("@/lib/utils/request-timeout", () => ({
  getRouteTimeoutMs: () => 30_000,
}));

const generateText = mock();
const streamText = mock();
const jsonSchemaMock = mock((schema: unknown) =>
  (aiActual.jsonSchema as (schema: unknown) => unknown)(schema),
);
mock.module("ai", () => ({
  ...aiActual,
  generateText,
  jsonSchema: jsonSchemaMock,
  streamText,
}));

const messagesRoute = (await import("../v1/messages/route")).default;

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  resolveInferenceAuthContext.mockReset();
  requireUserOrApiKeyWithOrg.mockReset();
  validateApiKey.mockReset();
  shouldBlockUser.mockReset();
  moderateInBackground.mockReset();
  reserveCredits.mockReset();
  billUsage.mockReset();
  estimateInputTokens.mockReset();
  recordUsageAnalytics.mockReset();
  reserveInferenceCredits.mockReset();
  getAuthorizedMonetizedAppForUser.mockReset();
  getAuthorizedMonetizedAppForUserCacheOnly.mockReset();
  admitAppInferenceCacheOnly.mockReset();
  assertInferenceAppAffiliateSupported.mockClear();
  createCreditReservationSettler.mockReset();
  generateText.mockReset();
  streamText.mockReset();
  jsonSchemaMock.mockReset();
  enforceOrgRateLimit.mockClear();
  orgRateLimitResult = null;
  orgRateLimitError = null;

  resolveInferenceAuthContext.mockResolvedValue({
    kind: "authorized",
    ctx: { userId: USER, orgId: ORG, apiKeyId: API_KEY_ID },
    source: "cache",
  });
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: USER,
    organization_id: ORG,
  });
  validateApiKey.mockResolvedValue({ id: API_KEY_ID });
  shouldBlockUser.mockResolvedValue(false);
  estimateInputTokens.mockReturnValue(8);
  getAuthorizedMonetizedAppForUser.mockResolvedValue(null);
  getAuthorizedMonetizedAppForUserCacheOnly.mockResolvedValue({
    kind: "ready",
    app: null,
  });
  admitAppInferenceCacheOnly.mockResolvedValue({
    mode: "deferred_app_reservation",
    estimatedTotalCostUsd: 0.002,
    settle: async () => null,
    settleUnknown: async () => null,
  });
  reserveCredits.mockResolvedValue({
    reservedAmount: 0.01,
    reconcile: async () => null,
  });
  reserveInferenceCredits.mockResolvedValue({
    reservedAmount: 0.02,
    reconcile: async () => null,
  });
  createCreditReservationSettler.mockReturnValue(async () => null);
  generateText.mockImplementation(() => {
    throw new Error("model-call-stub");
  });
  jsonSchemaMock.mockImplementation((schema: unknown) =>
    (aiActual.jsonSchema as (schema: unknown) => unknown)(schema),
  );
});

function postMessages(
  extraHeaders: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {},
) {
  return messagesRoute.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "eliza_test_key",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
      ...bodyOverrides,
    }),
  });
}

function postMessagesInWorker(
  extraHeaders: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {},
) {
  return messagesRoute.request(
    "/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "eliza_test_key",
        ...extraHeaders,
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 16,
        messages: [{ role: "user", content: "hello" }],
        ...bodyOverrides,
      }),
    },
    {},
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as never,
  );
}

describe("/v1/messages IAC fast path", () => {
  test("malformed request resolves auth once without deferral or provider admission", async () => {
    const response = await postMessagesInWorker({}, { messages: [] });

    expect(response.status).toBe(400);
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      deferStrongCredentialCheck: false,
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test("enabled Worker admission rejects a missing execution context without authoritative fallback", async () => {
    const response = await messagesRoute.request(
      "/",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "eliza_test_key",
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 16,
          messages: [{ role: "user", content: "hello" }],
        }),
      },
      { INFERENCE_DEFERRED_ADMISSION: "true" },
    );

    expect(response.status).toBe(503);
    expect(resolveInferenceAuthContext).not.toHaveBeenCalled();
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test("authorized resolver result skips serial auth, api-key lookup, and sync moderation", async () => {
    const response = await postMessages();

    expect(response.status).toBe(500);
    expect(resolveInferenceAuthContext).toHaveBeenCalledTimes(1);
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(shouldBlockUser).not.toHaveBeenCalled();
    expect(reserveCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        userId: USER,
      }),
      expect.any(Number),
      16,
      { subscriptionFunded: false },
    );
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("Worker requests fail closed while the API-key cache warms", async () => {
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "warming",
      message: "Inference authentication cache is warming. Retry shortly.",
    });

    const response = await postMessagesInWorker();

    expect(response.status).toBe(503);
    expect(resolveInferenceAuthContext.mock.calls[0]?.[1]).toMatchObject({
      cacheOnly: true,
    });
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test("shares the completions bucket and preserves Anthropic 429/503 envelopes", async () => {
    orgRateLimitResult = Response.json(
      { error: "Too many requests", code: "rate_limit_exceeded" },
      { status: 429, headers: { "Retry-After": "23" } },
    );

    const limited = await postMessagesInWorker();

    expect(enforceOrgRateLimit).toHaveBeenCalledWith(ORG, "completions", {
      cacheOnly: true,
      executionCtx: expect.any(Object),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("23");
    await expect(limited.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "rate_limit_error" },
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(admitAppInferenceCacheOnly).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();

    enforceOrgRateLimit.mockClear();
    orgRateLimitResult = null;
    orgRateLimitError = new TestOrgRateLimitCacheNotReadyError("warming");
    const warming = await postMessagesInWorker();

    expect(warming.status).toBe(503);
    expect(warming.headers.get("Retry-After")).toBe("1");
    await expect(warming.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "api_error" },
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(admitAppInferenceCacheOnly).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test("returns Anthropic 402 when organization credits are insufficient before provider dispatch", async () => {
    reserveCredits.mockRejectedValueOnce(
      new TestInsufficientCreditsError(0.025),
    );

    const response = await postMessages();

    expect(response.status).toBe(402);
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "billing_error",
        message: "Insufficient credits. Required: $0.0250",
      },
    });
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
    expect(billUsage).not.toHaveBeenCalled();
    expect(recordUsageAnalytics).not.toHaveBeenCalled();
    expect(createCreditReservationSettler).not.toHaveBeenCalled();
  });

  test("returns Anthropic 402 when monetized-app credits are insufficient before provider dispatch", async () => {
    const app = {
      id: "00000000-0000-4000-8000-0000000000dd",
      organization_id: ORG,
      created_by_user_id: USER,
      monetization_enabled: true,
      inference_markup_percentage: "100",
    };
    getAuthorizedMonetizedAppForUser.mockResolvedValueOnce(app);
    reserveInferenceCredits.mockRejectedValueOnce(
      new TestInsufficientCreditsError(0.03125),
    );

    const response = await postMessages(
      { "X-App-Id": app.id },
      { stream: true },
    );

    expect(response.status).toBe(402);
    expect(response.headers.get("Retry-After")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      type: "error",
      error: {
        type: "billing_error",
        message: "Insufficient cloud credits. Required: $0.0313",
      },
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
    expect(billUsage).not.toHaveBeenCalled();
    expect(recordUsageAnalytics).not.toHaveBeenCalled();
    expect(createCreditReservationSettler).not.toHaveBeenCalled();
  });

  test("suspended resolver result returns Anthropic 403 before billing or provider work", async () => {
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "suspended",
      userId: USER,
    });

    const response = await postMessages();

    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error?: { type?: string; message?: string };
    };
    expect(body.error?.type).toBe("permission_error");
    expect(body.error?.message).toContain("suspended");
    expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(shouldBlockUser).not.toHaveBeenCalled();
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test("preserves a cached standing 503 before billing or provider work", async () => {
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "rejected",
      status: 503,
    });

    const response = await postMessagesInWorker();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: {
        type: "service_unavailable",
        message: "Authorization service is unavailable. Retry shortly.",
      },
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("returns a typed cached standing reason before provider work", async () => {
    resolveInferenceAuthContext.mockResolvedValueOnce({
      kind: "rejected",
      status: 403,
      reason: "account_inactive",
    });

    const response = await postMessagesInWorker();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: {
        type: "permission_error",
        message: "Account is inactive",
      },
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("preserves a thrown auth-unavailable 503 instead of collapsing it to 401", async () => {
    const unavailable = new Error("revocation authority unavailable");
    unavailable.name = "InferenceCredentialRevocationUnavailableError";
    resolveInferenceAuthContext.mockRejectedValueOnce(unavailable);

    const response = await postMessagesInWorker();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: { type: "service_unavailable" },
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("maps an unexpected resolver failure to 500 instead of an auth rejection", async () => {
    resolveInferenceAuthContext.mockRejectedValueOnce(
      new Error("database connection reset"),
    );

    const response = await postMessagesInWorker();

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      type: "error",
      error: {
        type: "api_error",
        message: "Authorization could not be completed.",
      },
    });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("monetized X-App-Id messages use app-credit reservation with creator markup", async () => {
    const appReservation = {
      reservedAmount: 0.02,
      reconcile: async () => null,
    };
    const settleAppReservation = mock(async () => null);
    getAuthorizedMonetizedAppForUser.mockResolvedValueOnce({
      id: "00000000-0000-4000-8000-0000000000dd",
      monetization_enabled: true,
      inference_markup_percentage: "100",
    });
    reserveInferenceCredits.mockResolvedValueOnce(appReservation);
    createCreditReservationSettler.mockReturnValueOnce(settleAppReservation);
    generateText.mockResolvedValueOnce({
      text: "hello",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      finishReason: "stop",
    });
    billUsage.mockResolvedValueOnce({
      inputCost: 0.001,
      outputCost: 0.001,
      totalCost: 0.002,
      baseInputCost: 0.0008,
      baseOutputCost: 0.0008,
      baseTotalCost: 0.0016,
      platformMarkup: 0.0004,
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
      markupApplied: true,
    });

    const response = await postMessages({
      "X-App-Id": "00000000-0000-4000-8000-0000000000dd",
    });

    expect(response.status).toBe(200);
    expect(getAuthorizedMonetizedAppForUser).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-0000000000dd",
      { id: USER, organization_id: ORG },
    );
    expect(reserveInferenceCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "00000000-0000-4000-8000-0000000000dd",
        userId: USER,
        estimatedBaseCost: 0.002,
        description: "Messages API: anthropic/claude-3-5-sonnet-20241022",
        app: expect.objectContaining({
          id: "00000000-0000-4000-8000-0000000000dd",
        }),
      }),
    );
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(createCreditReservationSettler).toHaveBeenCalledWith(appReservation);
    expect(settleAppReservation).toHaveBeenCalledWith(0.002);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
  });

  test("Worker monetized-app admission uses only cache resolution and deferred reservation", async () => {
    const app = {
      id: "00000000-0000-4000-8000-0000000000dd",
      organization_id: ORG,
      created_by_user_id: USER,
      monetization_enabled: true,
      inference_markup_percentage: "100",
    };
    getAuthorizedMonetizedAppForUserCacheOnly.mockResolvedValueOnce({
      kind: "ready",
      app,
    });

    const response = await postMessagesInWorker({
      "X-App-Id": app.id,
    });

    expect(response.status).toBe(500);
    expect(getAuthorizedMonetizedAppForUserCacheOnly).toHaveBeenCalledWith(
      app.id,
      { id: USER, organization_id: ORG },
      expect.objectContaining({ executionCtx: expect.any(Object) }),
    );
    expect(getAuthorizedMonetizedAppForUser).not.toHaveBeenCalled();
    expect(admitAppInferenceCacheOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        app,
        appId: app.id,
        organizationId: ORG,
        userId: USER,
      }),
    );
    expect(reserveInferenceCredits).not.toHaveBeenCalled();
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  test("Worker app cache miss returns retryable 503 before admission or provider dispatch", async () => {
    getAuthorizedMonetizedAppForUserCacheOnly.mockResolvedValueOnce({
      kind: "warming",
      cacheRead: "miss",
    });

    const response = await postMessagesInWorker({
      "X-App-Id": "00000000-0000-4000-8000-0000000000dd",
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(admitAppInferenceCacheOnly).not.toHaveBeenCalled();
    expect(reserveInferenceCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test("app monetization plus affiliate attribution fails closed before provider dispatch", async () => {
    const app = {
      id: "00000000-0000-4000-8000-0000000000dd",
      organization_id: ORG,
      created_by_user_id: USER,
      monetization_enabled: true,
      inference_markup_percentage: "100",
    };
    getAuthorizedMonetizedAppForUserCacheOnly.mockResolvedValueOnce({
      kind: "ready",
      app,
    });

    const response = await postMessagesInWorker({
      "X-App-Id": app.id,
      "X-Affiliate-Code": "partner",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: "invalid_request_error" },
    });
    expect(assertInferenceAppAffiliateSupported).toHaveBeenCalledWith(
      app.id,
      "partner",
    );
    expect(admitAppInferenceCacheOnly).not.toHaveBeenCalled();
    expect(reserveInferenceCredits).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  test("refunds the reservation when post-reserve payload conversion throws", async () => {
    const settleReservation = mock(async () => null);
    createCreditReservationSettler.mockReturnValueOnce(settleReservation);
    jsonSchemaMock.mockImplementationOnce(() => {
      throw new Error("bad-tool-schema");
    });

    const response = await postMessages(
      {},
      {
        tools: [
          {
            name: "bad_tool",
            description: "malformed schema",
            input_schema: { type: "object" },
          },
        ],
      },
    );

    expect(response.status).toBe(500);
    expect(reserveCredits).toHaveBeenCalledTimes(1);
    expect(createCreditReservationSettler).toHaveBeenCalledTimes(1);
    expect(settleReservation).toHaveBeenCalledTimes(1);
    expect(settleReservation).toHaveBeenCalledWith(0);
    expect(generateText).not.toHaveBeenCalled();
    const body = (await response.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("bad-tool-schema");
  });
});
