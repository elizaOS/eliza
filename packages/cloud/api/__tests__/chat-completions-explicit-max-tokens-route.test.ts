/**
 * Route-level coverage for explicit chat-completion output ceilings.
 *
 * The production primitive is `computeEffectiveMaxTokens` inside the real
 * `handleChatCompletionsPOST` path: catalog reasoning metadata may raise an
 * omitted `max_tokens` to the response floor, but a caller-supplied ceiling is
 * a spend limit and must pass through to the provider unchanged.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

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
  requireAuthOrApiKeyWithOrg: mock(async () => ({
    user: { id: USER, organization_id: ORG },
    apiKey: { id: API_KEY_ID },
  })),
}));

mock.module("@/lib/services/inference-auth-context", () => ({
  resolveInferenceAuthContext: mock(async () => authResolution),
}));

mock.module("@/lib/middleware/rate-limit", () => ({
  enforceOrgRateLimit: mock(async () => null),
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { RELAXED: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/pricing", () => ({
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
  modelUsesReasoningTokens: (
    model: string,
    supportedParameters?: readonly string[],
  ) =>
    model.includes("o3") ||
    model.includes("reasoning") ||
    supportedParameters?.some((param) => param.includes("reasoning")) === true,
  normalizeModelName: (model: string) => model,
}));

mock.module("@/lib/providers/anthropic-thinking", () => ({
  mergeAnthropicCotProviderOptions: () => ({}),
  resolveAnthropicThinkingBudgetTokens: () => null,
}));

mock.module("@/lib/providers/anthropic-web-search", () => ({
  ANTHROPIC_WEB_SEARCH_INPUT_TOKEN_BUFFER: 0,
  buildProviderNativeWebSearchTools: () => ({}),
  isAnthropicWebSearchEnabled: () => false,
}));

mock.module("@/lib/providers/language-model", () => ({
  canonicalizeCerebrasModelId: (model: string) => model,
  getAiProviderConfigurationError: () => "AI services are not configured",
  getLanguageModel: (model: string) => ({ model }),
  hasLanguageModelProviderConfigured: () => providerConfigured,
  isProviderConfigurationError: () => false,
  resolveAiProviderSource: () => "gateway",
  resolvePassthroughUpstreamForModel: () => null,
  resolvePooledDirectProviderForModel: () => null,
}));

mock.module("@/lib/services/model-catalog", () => ({
  getCachedGatewayModelById: mock(async () => ({
    supported_parameters: catalogSupportedParameters,
  })),
}));

mock.module("@/lib/services/apps", () => ({
  appsService: {
    getAuthorizedMonetizedAppForUser: mock(async () => null),
    getById: mock(async () => null),
  },
}));

mock.module("@/lib/services/content-moderation", () => ({
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
  aiBillingRecordsService: { record: mock(async () => {}) },
}));

mock.module("@/lib/services/app-credits", () => ({
  appCreditsService: {
    reserveInferenceCredits: mock(async () => ({ id: "app-reservation-1" })),
  },
}));

mock.module("@/lib/services/credits", () => ({
  creditsService: {
    createAnonymousReservation: () => ({ id: "anonymous-reservation" }),
  },
}));

mock.module("@/lib/services/inference-billing-fast-path", () => ({
  createOptimisticDebitSettler: () => async () => null,
  getGateBalanceUsd: mock(async () => 0),
  isOptimisticBackstopAvailable: () => false,
  isOptimisticBillingEnabled: () => false,
  isOptimisticEligible: () => false,
  resolveSafeBalanceThresholdUsd: () => 5,
  writePendingInferenceCharge: mock(async () => false),
}));

mock.module("@/lib/services/inference-billing-ledger", () => ({
  admitInferenceChargeViaLedger: mock(async () => ({ admitted: false })),
  createLedgerDebitSettler: () => async () => null,
  resolveInferenceBillingLedger: () => "kv",
}));

mock.module("@/lib/services/inference-billing-deferred", () => ({
  createDeferredAdmissionSettler: () => async () => null,
  isDeferredAdmissionEnabled: () => false,
  isOrgAdmissionRefused: () => false,
}));

mock.module("@/lib/services/inference-passthrough", () => ({
  isPassthroughStreamingEnabled: () => false,
  readPassthroughStreamTail: mock(async () => ({ usage: null })),
}));

mock.module("@/lib/services/team-credential-pool", () => ({
  getTeamPoolRegistry: () => ({
    selectCredential: mock(async () => null),
    recordUse: mock(async () => {}),
    recordProviderFailure: mock(async () => {}),
  }),
}));

mock.module("@/lib/utils/credit-reservation", () => ({
  createCreditReservationSettler: () => async (actualCost: number) => ({
    reconciled: true,
    actualCost,
  }),
}));

mock.module("@/lib/utils/request-timeout", () => ({
  getRouteTimeoutMs: (seconds: number) => seconds * 1000,
}));

mock.module("@/lib/utils/settle-off-response-path", () => ({
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
