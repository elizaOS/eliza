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

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const APP_ID = "00000000-0000-4000-8000-0000000000dd";

mock.module("@/lib/pricing", () => ({
  calculateCost: async () => ({
    inputCost: 0.001,
    outputCost: 0.001,
    totalCost: 0.002,
  }),
  getProviderFromModel: () => "anthropic",
  getSafeModelParams: () => ({}),
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

mock.module("@/lib/providers/language-model", () => ({
  canonicalizeCerebrasModelId: (model: string) => model,
  getLanguageModel: () => ({}) as never,
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
  InsufficientCreditsError: TestInsufficientCreditsError,
  billUsage,
  estimateInputTokens,
  recordUsageAnalytics,
  reserveCredits,
}));

mock.module("@/lib/services/credits", () => ({
  creditsService: {
    createAnonymousReservation: () => ({
      reservedAmount: 0,
      reconcile: async () => null,
    }),
  },
}));

const deductCredits = mock();
const reconcileCredits = mock();
mock.module("@/lib/services/app-credits", () => ({
  appCreditsService: {
    calculateCostWithMarkup: async () => ({ totalCost: 0.002 }),
    checkBalance: async () => ({ sufficient: true }),
    deductCredits,
    reconcileCredits,
    recordUsage: async () => undefined,
  },
}));

const getAuthorizedMonetizedAppForUser = mock();
mock.module("@/lib/services/apps", () => ({
  appsService: {
    getAuthorizedMonetizedAppForUser,
    getById: async () => null,
  },
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
mock.module("ai", () => ({
  ...aiActual,
  generateText,
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
  deductCredits.mockReset();
  reconcileCredits.mockReset();
  getAuthorizedMonetizedAppForUser.mockReset();
  estimateInputTokens.mockReset();
  recordUsageAnalytics.mockReset();
  createCreditReservationSettler.mockReset();
  generateText.mockReset();

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
  reserveCredits.mockResolvedValue({
    reservedAmount: 0.01,
    reconcile: async () => null,
  });
  deductCredits.mockResolvedValue({
    success: true,
    baseCost: 0.003,
    creatorMarkup: 0,
    totalCost: 0.003,
    creatorEarnings: 0,
    newBalance: 1,
  });
  reconcileCredits.mockResolvedValue({
    reconciled: true,
    difference: -0.003,
    action: "refund",
    adjustedAmount: 0.003,
    newBalance: 1,
  });
  createCreditReservationSettler.mockReturnValue(async () => null);
  generateText.mockImplementation(() => {
    throw new Error("model-call-stub");
  });
});

function postMessages(headers: Record<string, string> = {}) {
  return messagesRoute.request("/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "eliza_test_key",
      ...headers,
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

describe("/v1/messages IAC fast path", () => {
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
    );
    expect(generateText).toHaveBeenCalledTimes(1);
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

  test("monetized app provider failure refunds the upfront app-credit hold", async () => {
    getAuthorizedMonetizedAppForUser.mockResolvedValueOnce({
      id: APP_ID,
      monetization_enabled: true,
      platform_offset_amount: "0",
      purchase_share_percentage: "0",
      inference_markup_percentage: "0",
    });

    const response = await postMessages({ "X-App-Id": APP_ID });

    expect(response.status).toBe(500);
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: APP_ID,
        userId: USER,
        baseCost: expect.closeTo(0.003, 10),
      }),
    );
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(reconcileCredits).toHaveBeenCalledTimes(1);
    expect(reconcileCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: APP_ID,
        userId: USER,
        estimatedBaseCost: expect.closeTo(0.003, 10),
        actualBaseCost: 0,
        metadata: expect.objectContaining({
          reason: "non_stream_error",
          streaming: false,
        }),
      }),
    );
  });
});
