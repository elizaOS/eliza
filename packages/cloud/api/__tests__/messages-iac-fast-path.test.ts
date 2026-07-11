/**
 * Route-level regression coverage for the /v1/messages IAC fast path.
 *
 * The route should use the shared inference-auth resolver for API-key requests,
 * skip the serial Hono auth/API-key lookup and synchronous moderation read on
 * authorized hits, and still return Anthropic-compatible 403s for suspended
 * users before any provider or billing work.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as authActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as pricingActual from "@/lib/pricing";
import * as anthropicThinkingActual from "@/lib/providers/anthropic-thinking";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as apiKeysActual from "@/lib/services/api-keys";
import * as appCreditsActual from "@/lib/services/app-credits";
import * as appsActual from "@/lib/services/apps";
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as creditsActual from "@/lib/services/credits";
import * as inferenceAuthContextActual from "@/lib/services/inference-auth-context";
import * as creditReservationActual from "@/lib/utils/credit-reservation";
import * as loggerActual from "@/lib/utils/logger";
import * as requestTimeoutActual from "@/lib/utils/request-timeout";

// Bun's changed-file coverage lane runs all selected suites in one process.
// Spread and restore every registry replacement so this route harness cannot
// leak partial module shapes into whichever test file the scheduler loads next.
const aiActual = require("ai") as Record<string, unknown>;

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";

mock.module("@/lib/pricing", () => ({
  ...pricingActual,
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
  ...anthropicThinkingActual,
  mergeAnthropicCotProviderOptions: () => ({}),
  resolveAnthropicThinkingBudgetTokens: () => null,
}));

const resolveInferenceAuthContext = mock();
mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthContextActual,
  resolveInferenceAuthContext,
}));

const requireUserOrApiKeyWithOrg = mock();
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...authActual,
  requireUserOrApiKeyWithOrg,
}));

const validateApiKey = mock();
mock.module("@/lib/services/api-keys", () => ({
  ...apiKeysActual,
  apiKeysService: {
    ...apiKeysActual.apiKeysService,
    validateApiKey,
  },
}));

const shouldBlockUser = mock();
const moderateInBackground = mock();
mock.module("@/lib/services/content-moderation", () => ({
  ...contentModerationActual,
  contentModerationService: {
    ...contentModerationActual.contentModerationService,
    shouldBlockUser,
    moderateInBackground,
  },
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { RELAXED: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
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
  InsufficientCreditsError: TestInsufficientCreditsError,
  billUsage,
  estimateInputTokens,
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
}));

mock.module("@/lib/services/credits", () => ({
  ...creditsActual,
  creditsService: {
    ...creditsActual.creditsService,
    createAnonymousReservation: () => ({
      reservedAmount: 0,
      reconcile: async () => null,
    }),
  },
}));

const reserveInferenceCredits = mock();
mock.module("@/lib/services/app-credits", () => ({
  ...appCreditsActual,
  appCreditsService: {
    ...appCreditsActual.appCreditsService,
    calculateCostWithMarkup: async () => ({ totalCost: 0.002 }),
    checkBalance: async () => ({ sufficient: true }),
    reserveInferenceCredits,
    recordUsage: async () => undefined,
  },
}));

const getAuthorizedMonetizedAppForUser = mock();
mock.module("@/lib/services/apps", () => ({
  ...appsActual,
  appsService: {
    ...appsActual.appsService,
    getAuthorizedMonetizedAppForUser,
    getById: async () => null,
  },
}));

const createCreditReservationSettler = mock();
mock.module("@/lib/utils/credit-reservation", () => ({
  ...creditReservationActual,
  createCreditReservationSettler,
}));

mock.module("@/lib/utils/logger", () => ({
  ...loggerActual,
  logger: {
    error: mock(),
    info: mock(),
    warn: mock(),
  },
}));

mock.module("@/lib/utils/request-timeout", () => ({
  ...requestTimeoutActual,
  getRouteTimeoutMs: () => 30_000,
}));

const generateText = mock();
const jsonSchemaMock = mock((schema: unknown) =>
  (aiActual.jsonSchema as (schema: unknown) => unknown)(schema),
);
mock.module("ai", () => ({
  ...aiActual,
  generateText,
  jsonSchema: jsonSchemaMock,
}));

const messagesRoute = (await import("../v1/messages/route")).default;

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/auth/workers-hono-auth", () => authActual);
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module(
    "@/lib/providers/anthropic-thinking",
    () => anthropicThinkingActual,
  );
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/pricing", () => pricingActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module("@/lib/services/api-keys", () => apiKeysActual);
  mock.module("@/lib/services/app-credits", () => appCreditsActual);
  mock.module("@/lib/services/apps", () => appsActual);
  mock.module(
    "@/lib/services/content-moderation",
    () => contentModerationActual,
  );
  mock.module("@/lib/services/credits", () => creditsActual);
  mock.module(
    "@/lib/services/inference-auth-context",
    () => inferenceAuthContextActual,
  );
  mock.module("@/lib/utils/credit-reservation", () => creditReservationActual);
  mock.module("@/lib/utils/logger", () => loggerActual);
  mock.module("@/lib/utils/request-timeout", () => requestTimeoutActual);
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
  createCreditReservationSettler.mockReset();
  generateText.mockReset();
  jsonSchemaMock.mockReset();

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
      "x-eliza-trace-id": "trace_messages_iac_12345678",
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
    expect(response.headers.get("X-Eliza-Trace-Id")).toBe(
      "trace_messages_iac_12345678",
    );
    expect(response.headers.get("X-Eliza-Preforward-Ms")).toMatch(
      /^total=\d+(?:\.\d+)?;auth=\d+(?:\.\d+)?;mid=\d+(?:\.\d+)?;reserve=\d+(?:\.\d+)?;setup=\d+(?:\.\d+)?$/,
    );
    expect(response.headers.get("Server-Timing")).toContain(
      "gateway_preforward;dur=",
    );
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
    expect(response.headers.get("X-Eliza-Trace-Id")).toBe(
      "trace_messages_iac_12345678",
    );
    expect(response.headers.get("Server-Timing")).toContain(
      "gateway_preforward;dur=",
    );
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
