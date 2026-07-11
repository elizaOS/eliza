/**
 * Route-level coverage for explicit chat-completion output ceilings.
 *
 * The production primitive is `computeEffectiveMaxTokens` inside the real
 * `handleChatCompletionsPOST` path: catalog reasoning metadata may raise an
 * omitted `max_tokens` to the response floor, but a caller-supplied ceiling is
 * a spend limit and must pass through to the provider unchanged.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Keep the real modules so afterAll can restore them — bun's `mock.module` is
// process-global and leaks into sibling test files in the same batch process
// otherwise. Every mock below spreads its actual so unrelated exports stay
// real, and afterAll re-registers the actuals verbatim.
const aiActual = require("ai") as Record<string, unknown>;

import * as authActual from "@/lib/auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit";
import * as rateLimitHonoActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as pricingActual from "@/lib/pricing";
import * as anthropicThinkingActual from "@/lib/providers/anthropic-thinking";
import * as anthropicWebSearchActual from "@/lib/providers/anthropic-web-search";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as aiBillingRecordsActual from "@/lib/services/ai-billing-records";
import * as appCreditsActual from "@/lib/services/app-credits";
import * as appsActual from "@/lib/services/apps";
import * as contentModerationActual from "@/lib/services/content-moderation";
import * as creditsActual from "@/lib/services/credits";
import * as inferenceAuthContextActual from "@/lib/services/inference-auth-context";
import * as inferenceBillingDeferredActual from "@/lib/services/inference-billing-deferred";
import * as inferenceBillingFastPathActual from "@/lib/services/inference-billing-fast-path";
import * as inferenceBillingLedgerActual from "@/lib/services/inference-billing-ledger";
import * as inferencePassthroughActual from "@/lib/services/inference-passthrough";
import * as modelCatalogActual from "@/lib/services/model-catalog";
import * as teamCredentialPoolActual from "@/lib/services/team-credential-pool";
import * as creditReservationActual from "@/lib/utils/credit-reservation";
import * as requestTimeoutActual from "@/lib/utils/request-timeout";
import * as settleOffResponsePathActual from "@/lib/utils/settle-off-response-path";

const MOCKED_MODULE_ACTUALS: ReadonlyArray<
  [specifier: string, actual: Record<string, unknown>]
> = [
  ["ai", aiActual],
  ["@/lib/auth", authActual as Record<string, unknown>],
  ["@/lib/middleware/rate-limit", rateLimitActual as Record<string, unknown>],
  [
    "@/lib/middleware/rate-limit-hono-cloudflare",
    rateLimitHonoActual as Record<string, unknown>,
  ],
  ["@/lib/pricing", pricingActual as Record<string, unknown>],
  [
    "@/lib/providers/anthropic-thinking",
    anthropicThinkingActual as Record<string, unknown>,
  ],
  [
    "@/lib/providers/anthropic-web-search",
    anthropicWebSearchActual as Record<string, unknown>,
  ],
  [
    "@/lib/providers/language-model",
    languageModelActual as Record<string, unknown>,
  ],
  ["@/lib/services/ai-billing", aiBillingActual as Record<string, unknown>],
  [
    "@/lib/services/ai-billing-records",
    aiBillingRecordsActual as Record<string, unknown>,
  ],
  ["@/lib/services/app-credits", appCreditsActual as Record<string, unknown>],
  ["@/lib/services/apps", appsActual as Record<string, unknown>],
  [
    "@/lib/services/content-moderation",
    contentModerationActual as Record<string, unknown>,
  ],
  ["@/lib/services/credits", creditsActual as Record<string, unknown>],
  [
    "@/lib/services/inference-auth-context",
    inferenceAuthContextActual as Record<string, unknown>,
  ],
  [
    "@/lib/services/inference-billing-deferred",
    inferenceBillingDeferredActual as Record<string, unknown>,
  ],
  [
    "@/lib/services/inference-billing-fast-path",
    inferenceBillingFastPathActual as Record<string, unknown>,
  ],
  [
    "@/lib/services/inference-billing-ledger",
    inferenceBillingLedgerActual as Record<string, unknown>,
  ],
  [
    "@/lib/services/inference-passthrough",
    inferencePassthroughActual as Record<string, unknown>,
  ],
  [
    "@/lib/services/model-catalog",
    modelCatalogActual as Record<string, unknown>,
  ],
  [
    "@/lib/services/team-credential-pool",
    teamCredentialPoolActual as Record<string, unknown>,
  ],
  [
    "@/lib/utils/credit-reservation",
    creditReservationActual as Record<string, unknown>,
  ],
  [
    "@/lib/utils/request-timeout",
    requestTimeoutActual as Record<string, unknown>,
  ],
  [
    "@/lib/utils/settle-off-response-path",
    settleOffResponsePathActual as Record<string, unknown>,
  ],
];

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const API_KEY_ID = "00000000-0000-4000-8000-0000000000cc";
const MODEL = "z-ai/glm-5.1";
const MIN_RESPONSE_TOKENS = 4096;

const generateTextCalls: Array<Record<string, unknown>> = [];
const streamTextCalls: Array<Record<string, unknown>> = [];
let catalogSupportedParameters: string[] | undefined = [
  "max_tokens",
  "reasoning",
];
let generateTextResult: {
  text: string;
  finishReason: string;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  usage: Record<string, unknown>;
};
let authResolution:
  | {
      kind: "authorized";
      ctx: { userId: string; orgId: string; apiKeyId: string };
    }
  | { kind: "suspended" }
  | { kind: "miss" };
let providerConfigured = true;
let shouldBlockUser = false;
let reserveCreditsImpl: () => Promise<unknown>;

mock.module("ai", () => ({
  ...aiActual,
  APICallError: { isInstance: () => false },
  RetryError: { isInstance: () => false },
  jsonSchema: (schema: unknown) => ({ schema }),
  generateText: mock(async (params: Record<string, unknown>) => {
    generateTextCalls.push(params);
    return generateTextResult;
  }),
  streamText: mock((params: Record<string, unknown>) => {
    streamTextCalls.push(params);
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", text: "streamed " };
        yield { type: "text-delta", text: "answer" };
        await (
          params.onFinish as (result: {
            text: string;
            usage: {
              inputTokens: number;
              outputTokens: number;
              totalTokens: number;
            };
          }) => Promise<void>
        )({
          text: "streamed answer",
          usage: { inputTokens: 13, outputTokens: 8, totalTokens: 21 },
        });
        yield {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 13, outputTokens: 8, totalTokens: 21 },
        };
      })(),
    };
  }),
}));

mock.module("@/lib/auth", () => ({
  ...authActual,
  requireAuthOrApiKeyWithOrg: mock(async () => ({
    user: { id: USER, organization_id: ORG },
    apiKey: { id: API_KEY_ID },
  })),
}));

mock.module("@/lib/services/inference-auth-context", () => ({
  ...inferenceAuthContextActual,
  resolveInferenceAuthContext: mock(async () => authResolution),
}));

mock.module("@/lib/middleware/rate-limit", () => ({
  ...rateLimitActual,
  enforceOrgRateLimit: mock(async () => null),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitHonoActual,
  RateLimitPresets: { RELAXED: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/pricing", () => ({
  ...pricingActual,
  calculateCost: mock(async () => ({
    totalCost: 0.001,
    inputCost: 0.0005,
    outputCost: 0.0005,
  })),
  estimateTokens: (text: string) => Math.max(1, Math.ceil(text.length / 4)),
  getProviderFromModel: () => "gateway",
  getSafeModelParams: (_model: string, params: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(params).filter(([, value]) => value !== undefined),
    ),
  // modelUsesReasoningTokens and normalizeModelName come from ...pricingActual
  // above: MODEL ("z-ai/glm-5.1") is only reasoning-flagged via
  // catalogSupportedParameters (mocked below), which the real implementation
  // already honors, so the real function is a safe drop-in that avoids
  // diverging from production behavior across test files sharing this
  // process-global mock registry.
}));

mock.module("@/lib/providers/anthropic-thinking", () => ({
  ...anthropicThinkingActual,
  mergeAnthropicCotProviderOptions: () => ({}),
  resolveAnthropicThinkingBudgetTokens: () => null,
}));

mock.module("@/lib/providers/anthropic-web-search", () => ({
  ...anthropicWebSearchActual,
  ANTHROPIC_WEB_SEARCH_INPUT_TOKEN_BUFFER: 0,
  buildProviderNativeWebSearchTools: () => ({}),
  isAnthropicWebSearchEnabled: () => false,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  // canonicalizeCerebrasModelId comes from ...languageModelActual above: MODEL
  // is not a Cerebras-native id, so the real implementation is a no-op here
  // and stays correct if a sibling test file in this batch process needs the
  // real Cerebras-canonicalization behavior.
  getAiProviderConfigurationError: () => "AI services are not configured",
  getLanguageModel: (model: string) => ({ model }),
  hasLanguageModelProviderConfigured: () => providerConfigured,
  isProviderConfigurationError: () => false,
  resolveAiProviderSource: () => "gateway",
  resolvePassthroughUpstreamForModel: () => null,
  resolvePooledDirectProviderForModel: () => null,
}));

mock.module("@/lib/services/model-catalog", () => ({
  ...modelCatalogActual,
  getCachedGatewayModelById: mock(async () => ({
    supported_parameters: catalogSupportedParameters,
  })),
}));

mock.module("@/lib/services/apps", () => ({
  ...appsActual,
  appsService: {
    getAuthorizedMonetizedAppForUser: mock(async () => null),
    getById: mock(async () => null),
  },
}));

mock.module("@/lib/services/content-moderation", () => ({
  ...contentModerationActual,
  contentModerationService: {
    shouldBlockUser: mock(async () => shouldBlockUser),
    moderateInBackground: mock(() => {}),
  },
}));

class TestInsufficientCreditsError extends Error {
  required: number;

  constructor(required: number) {
    super("Insufficient credits");
    this.required = required;
  }
}

mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  estimateInputTokens: (messages: Array<{ content: string }>) =>
    messages.reduce((sum, message) => sum + message.content.length, 0),
  reserveCredits: mock(async () => reserveCreditsImpl()),
  billUsage: mock(async (_context: unknown, usage: Record<string, number>) => ({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    totalCost: 0.001,
  })),
  recordUsageAnalytics: mock(async () => ({ id: "usage-record-1" })),
  InsufficientCreditsError: TestInsufficientCreditsError,
}));

mock.module("@/lib/services/ai-billing-records", () => ({
  ...aiBillingRecordsActual,
  aiBillingRecordsService: { record: mock(async () => {}) },
}));

mock.module("@/lib/services/app-credits", () => ({
  ...appCreditsActual,
  appCreditsService: {
    reserveInferenceCredits: mock(async () => ({ id: "app-reservation-1" })),
  },
}));

mock.module("@/lib/services/credits", () => ({
  ...creditsActual,
  creditsService: {
    createAnonymousReservation: () => ({ id: "anonymous-reservation" }),
  },
}));

mock.module("@/lib/services/inference-billing-fast-path", () => ({
  ...inferenceBillingFastPathActual,
  createOptimisticDebitSettler: () => async () => null,
  getGateBalanceUsd: mock(async () => 0),
  isOptimisticBackstopAvailable: () => false,
  isOptimisticBillingEnabled: () => false,
  isOptimisticEligible: () => false,
  resolveSafeBalanceThresholdUsd: () => 5,
  writePendingInferenceCharge: mock(async () => false),
}));

mock.module("@/lib/services/inference-billing-ledger", () => ({
  ...inferenceBillingLedgerActual,
  admitInferenceChargeViaLedger: mock(async () => ({ admitted: false })),
  createLedgerDebitSettler: () => async () => null,
  resolveInferenceBillingLedger: () => "kv",
}));

mock.module("@/lib/services/inference-billing-deferred", () => ({
  ...inferenceBillingDeferredActual,
  createDeferredAdmissionSettler: () => async () => null,
  isDeferredAdmissionEnabled: () => false,
  isOrgAdmissionRefused: () => false,
}));

mock.module("@/lib/services/inference-passthrough", () => ({
  ...inferencePassthroughActual,
  isPassthroughStreamingEnabled: () => false,
  readPassthroughStreamTail: mock(async () => ({ usage: null })),
}));

mock.module("@/lib/services/team-credential-pool", () => ({
  ...teamCredentialPoolActual,
  getTeamPoolRegistry: () => ({
    selectCredential: mock(async () => null),
    recordUse: mock(async () => {}),
    recordProviderFailure: mock(async () => {}),
  }),
}));

mock.module("@/lib/utils/credit-reservation", () => ({
  ...creditReservationActual,
  createCreditReservationSettler: () => async (actualCost: number) => ({
    reconciled: true,
    actualCost,
  }),
}));

mock.module("@/lib/utils/request-timeout", () => ({
  ...requestTimeoutActual,
  getRouteTimeoutMs: (seconds: number) => seconds * 1000,
}));

mock.module("@/lib/utils/settle-off-response-path", () => ({
  ...settleOffResponsePathActual,
  settleOffResponsePath: async (
    _executionCtx: unknown,
    work: () => Promise<void>,
  ) => {
    await work();
  },
}));

const { handleChatCompletionsPOST } = await import(
  "../v1/chat/completions/route"
);

afterAll(() => {
  for (const [specifier, actual] of MOCKED_MODULE_ACTUALS) {
    mock.module(specifier, () => actual);
  }
});

beforeEach(() => {
  generateTextCalls.length = 0;
  streamTextCalls.length = 0;
  catalogSupportedParameters = ["max_tokens", "reasoning"];
  authResolution = {
    kind: "authorized",
    ctx: { userId: USER, orgId: ORG, apiKeyId: API_KEY_ID },
  };
  providerConfigured = true;
  shouldBlockUser = false;
  reserveCreditsImpl = async () => ({ id: "reservation-1" });
  generateTextResult = {
    text: "bounded answer",
    finishReason: "stop",
    toolCalls: [],
    usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
  };
});

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("https://api.test/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      ...body,
    }),
  });
}

describe("chat/completions explicit max_tokens route behavior", () => {
  test("returns the designed suspended-account error from the hot auth path", async () => {
    authResolution = { kind: "suspended" };

    const response = await handleChatCompletionsPOST(makeRequest({}), {
      skipOrgRateLimit: true,
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: { type: string; code: string };
    };
    expect(body.error.type).toBe("account_suspended");
    expect(body.error.code).toBe("moderation_violation");
    expect(generateTextCalls).toHaveLength(0);
  });

  test("returns invalid_request_error when model or messages are missing", async () => {
    const response = await handleChatCompletionsPOST(
      new Request("https://api.test/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: [] }),
      }),
      { skipOrgRateLimit: true },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { type: string; code: string };
    };
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("missing_required_parameter");
    expect(generateTextCalls).toHaveLength(0);
  });

  test("returns service_unavailable before forwarding when no provider is configured", async () => {
    providerConfigured = false;

    const response = await handleChatCompletionsPOST(makeRequest({}), {
      skipOrgRateLimit: true,
    });

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { type: string; code: string };
    };
    expect(body.error.type).toBe("service_unavailable");
    expect(body.error.code).toBe("ai_not_configured");
    expect(generateTextCalls).toHaveLength(0);
  });

  test("slow-path moderation blocks before credit reservation and provider forwarding", async () => {
    authResolution = { kind: "miss" };
    shouldBlockUser = true;

    const response = await handleChatCompletionsPOST(makeRequest({}), {
      skipOrgRateLimit: true,
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: { type: string; code: string };
    };
    expect(body.error.type).toBe("account_suspended");
    expect(body.error.code).toBe("moderation_violation");
    expect(generateTextCalls).toHaveLength(0);
  });

  test("insufficient organization credits are translated before provider forwarding", async () => {
    reserveCreditsImpl = async () => {
      throw new TestInsufficientCreditsError(0.025);
    };

    const response = await handleChatCompletionsPOST(makeRequest({}), {
      skipOrgRateLimit: true,
    });

    expect(response.status).toBe(402);
    const body = (await response.json()) as {
      error: { type: string; code: string; message: string };
    };
    expect(body.error.type).toBe("insufficient_quota");
    expect(body.error.code).toBe("insufficient_credits");
    expect(body.error.message).toContain("$0.0250");
    expect(generateTextCalls).toHaveLength(0);
  });

  test("non-streaming preserves a caller max_tokens ceiling even when catalog marks the model as reasoning-capable", async () => {
    const response = await handleChatCompletionsPOST(
      makeRequest({ max_tokens: 16 }),
      { skipOrgRateLimit: true },
    );

    expect(response.status).toBe(200);
    expect(generateTextCalls).toHaveLength(1);
    expect(generateTextCalls[0].maxOutputTokens).toBe(16);

    const body = (await response.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(body.choices[0].message.content).toBe("bounded answer");
    expect(body.choices[0].finish_reason).toBe("stop");
    expect(body.usage.completion_tokens).toBe(7);
  });

  test("non-streaming applies the reasoning floor only when max_tokens is omitted", async () => {
    const response = await handleChatCompletionsPOST(makeRequest({}), {
      skipOrgRateLimit: true,
    });

    expect(response.status).toBe(200);
    expect(generateTextCalls).toHaveLength(1);
    expect(generateTextCalls[0].maxOutputTokens).toBe(MIN_RESPONSE_TOKENS);
  });

  test("non-streaming maps provider tool calls back to OpenAI tool_calls", async () => {
    generateTextResult = {
      text: "",
      finishReason: "tool-calls",
      toolCalls: [
        {
          toolCallId: "call-1",
          toolName: "lookup",
          input: { q: "elizaOS" },
        },
      ],
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        totalTokens: 14,
        cacheReadInputTokens: 3,
      },
    };

    const response = await handleChatCompletionsPOST(makeRequest({}), {
      skipOrgRateLimit: true,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.tool_calls[0].id).toBe("call-1");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("lookup");
    expect(body.choices[0].message.tool_calls[0].function.arguments).toBe(
      '{"q":"elizaOS"}',
    );
    expect(body.usage.prompt_tokens_details?.cached_tokens).toBe(3);
  });

  test("non-streaming reports empty-but-billed reasoning output as length", async () => {
    generateTextResult = {
      text: "",
      finishReason: "stop",
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 12, totalTokens: 17 },
    };

    const response = await handleChatCompletionsPOST(
      makeRequest({ max_tokens: 12 }),
      { skipOrgRateLimit: true },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: Array<{
        message: { content: string | null };
        finish_reason: string;
      }>;
    };
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].finish_reason).toBe("length");
  });

  test("streaming preserves explicit max_tokens and emits the OpenAI usage frame", async () => {
    const response = await handleChatCompletionsPOST(
      makeRequest({
        stream: true,
        max_tokens: 12,
        stream_options: { include_usage: true },
      }),
      { skipOrgRateLimit: true },
    );

    expect(response.status).toBe(200);
    const sse = await response.text();

    expect(streamTextCalls).toHaveLength(1);
    expect(streamTextCalls[0].maxOutputTokens).toBe(12);
    expect(sse).toContain("streamed ");
    expect(sse).toContain('"choices":[]');
    expect(sse).toContain('"completion_tokens":8');
    expect(sse).toContain("data: [DONE]");
  });
});
