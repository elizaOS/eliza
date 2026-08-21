/**
 * Pass-through streaming fast path (#15428) for POST /api/v1/chat/completions.
 * Requests drive the real authorization and credit-admission boundary.
 *
 * Drives the REAL streaming handler with a mocked global `fetch` (the direct
 * upstream boundary) and the REAL credit-reservation settler, mirroring
 * chat-completions-streaming-credit-leak. Asserts the fast-path contract:
 * qualifying requests pipe the upstream SSE bytes VERBATIM (no re-encode)
 * while usage is metered from the teed branch and billed through the same
 * settle chain with the same amounts as the SDK path; non-qualifying requests
 * and flag-off fall through to `streamText` untouched; client aborts cancel
 * the upstream fetch and settle the delivered portion; upstream errors refund
 * the hold fail-closed.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Spread the real module so other test files importing from "ai" are not
// stranded by the process-wide registry replacement; restore in afterAll.
const aiActual = require("ai") as Record<string, unknown>;

import { getCloudTelemetrySnapshot } from "@/lib/observability/cloud-backend-observability";
import { estimateTokens } from "@/lib/pricing";
import * as languageModelActual from "@/lib/providers/language-model";
import * as aiBillingActual from "@/lib/services/ai-billing";
import * as aiBillingRecordsActual from "@/lib/services/ai-billing-records";
import { InferenceAdmissionDispatchMarkError } from "@/lib/services/inference-admission-gate";
import * as teamCredentialPoolActual from "@/lib/services/team-credential-pool";

// The REAL settler — explicitly NOT mocked; reservation math is under test.
import { createCreditReservationSettler } from "@/lib/utils/credit-reservation";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
// Cerebras-native id in dedicated-agent decorated form; the fast path must
// normalize it to the bare id when forwarding upstream.
const MODEL = "openai/gpt-oss-120b";

// --- module mocks (same boundaries as the sibling streaming suites) ---------
let generateTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const generateText = mock((config: Record<string, unknown>) => {
  if (!generateTextImpl) throw new Error("generateTextImpl not set");
  return generateTextImpl(config);
});
let streamTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const streamText = mock((config: Record<string, unknown>) => {
  if (!streamTextImpl) throw new Error("streamTextImpl not set");
  return streamTextImpl(config);
});
mock.module("ai", () => ({
  ...aiActual,
  generateText,
  streamText,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getLanguageModel: () => ({}) as never,
}));

const INPUT_TOKEN_COST = 0.001;
const OUTPUT_TOKEN_COST = 0.01;
// When set, billUsage blocks until the gate resolves — the waitUntil test
// holds the settle chain open to prove the piped bytes never wait on billing.
let billUsageGate: Promise<void> | null = null;
const billUsage = mock(async (_context: unknown, usage: unknown) => {
  if (billUsageGate) await billUsageGate;
  const record =
    usage && typeof usage === "object"
      ? (usage as {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        })
      : {};
  const inputTokens = record.inputTokens ?? 0;
  const outputTokens = record.outputTokens ?? 0;
  const inputCost = inputTokens * INPUT_TOKEN_COST;
  const outputCost = outputTokens * OUTPUT_TOKEN_COST;
  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    baseInputCost: inputCost,
    baseOutputCost: outputCost,
    baseTotalCost: inputCost + outputCost,
    platformMarkup: 0,
    inputTokens,
    outputTokens,
    totalTokens: record.totalTokens ?? inputTokens + outputTokens,
    markupApplied: true,
  };
});
const recordUsageAnalytics = mock(async () => ({ id: "usage-1" }));
mock.module("@/lib/services/ai-billing", () => ({
  ...aiBillingActual,
  billUsage,
  recordUsageAnalytics,
}));

const aiBillingRecord = mock(async () => ({ id: "billing-record-1" }));
mock.module("@/lib/services/ai-billing-records", () => ({
  ...aiBillingRecordsActual,
  aiBillingRecordsService: {
    ...aiBillingRecordsActual.aiBillingRecordsService,
    record: aiBillingRecord,
  },
}));

const poolRecordUse = mock(async () => {});
const poolRecordProviderFailure = mock(async () => {});
mock.module("@/lib/services/team-credential-pool", () => ({
  ...teamCredentialPoolActual,
  getTeamPoolRegistry: () => ({
    recordUse: poolRecordUse,
    recordProviderFailure: poolRecordProviderFailure,
  }),
}));

// Import the route AFTER the mocks so it binds to the stubs.
const {
  default: chatCompletionsRouter,
  __streamingCreditTestHooks,
  __passthroughStreamingTestHooks,
  __reasoningEffortTestHooks,
} = await import("../v1/chat/completions/route");
const { handleStreamingRequest } = __streamingCreditTestHooks;
const { handleNonStreamingRequest } = __reasoningEffortTestHooks;
const { qualifiesForPassthroughStreaming, mapPassthroughUpstreamStatus } =
  __passthroughStreamingTestHooks;

// --- global fetch mock (the direct upstream boundary) ------------------------
const realFetch = globalThis.fetch;
let fetchImpl:
  | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
  | null = null;
const fetchMock = mock(
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!fetchImpl) throw new Error("fetchImpl not set");
    return fetchImpl(input, init);
  },
);

const ENV_KEYS = [
  "INFERENCE_PASSTHROUGH_STREAMING",
  "CEREBRAS_API_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
  mock.module("@/lib/services/ai-billing", () => aiBillingActual);
  mock.module(
    "@/lib/services/ai-billing-records",
    () => aiBillingRecordsActual,
  );
  mock.module(
    "@/lib/services/team-credential-pool",
    () => teamCredentialPoolActual,
  );
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  generateText.mockClear();
  streamText.mockClear();
  billUsage.mockClear();
  recordUsageAnalytics.mockClear();
  aiBillingRecord.mockClear();
  poolRecordUse.mockClear();
  poolRecordProviderFailure.mockClear();
  fetchMock.mockClear();
  generateTextImpl = null;
  streamTextImpl = null;
  fetchImpl = null;
  billUsageGate = null;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.INFERENCE_PASSTHROUGH_STREAMING = "true";
  process.env.CEREBRAS_API_KEY = "test-cerebras-key";
});

test("the route ignores the retired native limiter and still fails closed before provider work", async () => {
  // #17805 removed the per-route native Cloudflare gate from the generative
  // hot path: rate policy now rides the IAC v2 admission snapshot through the
  // org-level limiter. Even a PRESENT and DENYING binding must never be
  // consulted, and the pre-provider guarantee now belongs to the auth /
  // admission boundary — an unauthorized request must produce a failure
  // without a single provider dispatch.
  const keys: string[] = [];
  const response = await chatCompletionsRouter.fetch(
    new Request("https://api.example.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(QUALIFYING_REQUEST),
    }),
    {
      NODE_ENV: "production",
      CHAT_ROUTE_RATE_LIMITER: {
        async limit({ key }: { key: string }) {
          keys.push(key);
          return { success: false };
        },
      },
    } as never,
  );

  expect(keys).toEqual([]);
  expect(response.headers.get("X-RateLimit-Policy")).toBeNull();
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(generateText).not.toHaveBeenCalled();
  expect(streamText).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

/** In-memory credit ledger, identical to the credit-leak suite's. */
function makeLedgerReservation(startBalance: number, hold: number) {
  let balance = startBalance - hold;
  let reconcileCalls = 0;
  const actualCosts: number[] = [];
  return {
    startBalance,
    hold,
    get balance() {
      return balance;
    },
    get reconcileCalls() {
      return reconcileCalls;
    },
    get actualCosts() {
      return actualCosts;
    },
    reservation: {
      reservedAmount: hold,
      reconcile: async (actualCost: number) => {
        reconcileCalls++;
        actualCosts.push(actualCost);
        balance += hold - actualCost;
        return undefined;
      },
    },
  };
}

const QUALIFYING_REQUEST: Record<string, unknown> = {
  model: MODEL,
  messages: [{ role: "user", content: "hello" }],
  stream: true,
  stream_options: { include_usage: true },
};

function callStreaming(
  settleReservation: (actualCost: number) => Promise<unknown> | unknown,
  options: {
    model?: string;
    request?: unknown;
    estimatedInputTokens?: number;
    signal?: AbortSignal;
    effectiveMaxTokens?: number;
    pooledCredential?: unknown;
    executionCtx?: { waitUntil(promise: Promise<unknown>): void };
    settleUnknown?: () => Promise<unknown> | unknown;
    providerDispatchTelemetry?: {
      capture(): void;
      emit(): void;
    };
    markProviderDispatched?: () => Promise<void>;
  } = {},
) {
  return handleStreamingRequest(
    options.model ?? MODEL,
    undefined,
    [{ role: "user", content: "hello" }] as never,
    (options.request ?? QUALIFYING_REQUEST) as never,
    { id: USER, organization_id: ORG },
    null,
    null,
    "idem-1",
    "req-1",
    null,
    Date.now(),
    options.signal,
    30_000,
    options.estimatedInputTokens ?? 1,
    settleReservation as never,
    (options.settleUnknown ?? (async () => null)) as never,
    undefined,
    {} as never,
    options.effectiveMaxTokens,
    {} as never,
    "cerebras" as never,
    (options.pooledCredential ?? null) as never,
    false,
    options.executionCtx,
    options.providerDispatchTelemetry,
    options.markProviderDispatched,
  );
}

function callNonStreaming(
  model: string,
  reasoningEffort: "none" | "low",
  promptCacheKey?: string,
  settlement?: {
    settle(actualCost: number): Promise<unknown>;
    settleUnknown(): Promise<unknown>;
  },
) {
  return handleNonStreamingRequest(
    model,
    undefined,
    [{ role: "user", content: "hello" }] as never,
    {
      model,
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: reasoningEffort,
      ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    } as never,
    { id: USER, organization_id: ORG },
    null,
    null,
    "idem-1",
    "req-1",
    null,
    Date.now(),
    undefined,
    30_000,
    (settlement?.settle ?? (async () => null)) as never,
    (settlement?.settleUnknown ?? (async () => null)) as never,
    undefined,
    {} as never,
    512,
    {} as never,
    "cerebras" as never,
    null,
    false,
    undefined,
  );
}

const encoder = new TextEncoder();

function sseResponse(body: string, status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status, headers: { "Content-Type": "text/event-stream" } },
  );
}

// Deliberately quirky upstream bytes (vendor extension field, reasoning delta,
// upstream-chosen id) — the SDK re-encoder would normalize all of this away,
// so a strict equality on the response body proves zero re-encode.
const UPSTREAM_SSE =
  `data: {"id":"chatcmpl-upstream-1","object":"chat.completion.chunk","created":7,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel","reasoning":"thinking..."},"finish_reason":null}],"usage":null,"x_vendor":{"queue_ms":3}}\n\n` +
  `data: {"id":"chatcmpl-upstream-1","object":"chat.completion.chunk","created":7,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}],"usage":null}\n\n` +
  `data: {"id":"chatcmpl-upstream-1","object":"chat.completion.chunk","created":7,"model":"gpt-oss-120b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}\n\n` +
  `data: {"id":"chatcmpl-upstream-1","object":"chat.completion.chunk","created":7,"model":"gpt-oss-120b","choices":[],"usage":{"prompt_tokens":72,"completion_tokens":60,"total_tokens":132,"prompt_tokens_details":{"cached_tokens":7}}}\n\n` +
  `data: [DONE]\n\n`;

const USAGE_TOKENS = { inputTokens: 72, outputTokens: 60, totalTokens: 132 };
const EXPECTED_COST =
  USAGE_TOKENS.inputTokens * INPUT_TOKEN_COST +
  USAGE_TOKENS.outputTokens * OUTPUT_TOKEN_COST;

/** SDK-path double for fallthrough assertions and the billing-parity test. */
function sdkFaithfulStream(usage = USAGE_TOKENS, text = "Hello") {
  streamTextImpl = (config) => {
    const onFinish = config.onFinish as (event: {
      text: string;
      usage: typeof usage;
    }) => Promise<unknown>;
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", id: "text-1", text };
        await onFinish({ text, usage });
        yield { type: "finish", finishReason: "stop", totalUsage: usage };
      })(),
    };
  };
}

describe("passthrough streaming — qualification predicate", () => {
  const base = {
    model: MODEL,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    stream_options: { include_usage: true },
  };
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["plain streamed chat qualifies", base, true],
    ["non-streaming", { ...base, stream: false }, false],
    ["missing include_usage", { ...base, stream_options: {} }, false],
    [
      "tools present",
      {
        ...base,
        tools: [{ type: "function", function: { name: "t" } }],
      },
      false,
    ],
    ["tool_choice present", { ...base, tool_choice: "auto" }, false],
    [
      "response_format json_object",
      { ...base, response_format: { type: "json_object" } },
      false,
    ],
    [
      "response_format text still qualifies",
      { ...base, response_format: { type: "text" } },
      true,
    ],
    ["web search", { ...base, webSearchEnabled: true }, false],
    [
      "multimodal content parts",
      {
        ...base,
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "http://x/i.png" } },
            ],
          },
        ],
      },
      false,
    ],
    [
      "assistant tool_calls in history",
      {
        ...base,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "t", arguments: "{}" },
              },
            ],
          },
        ],
      },
      false,
    ],
    [
      "tool-role message in history",
      {
        ...base,
        messages: [{ role: "tool", content: "result", tool_call_id: "c1" }],
      },
      false,
    ],
  ];
  for (const [name, request, expected] of cases) {
    test(name, () => {
      expect(qualifiesForPassthroughStreaming(request as never)).toBe(expected);
    });
  }

  test("upstream status mapping mirrors the SDK path's classification", () => {
    expect(mapPassthroughUpstreamStatus(400)).toBe(400);
    expect(mapPassthroughUpstreamStatus(402)).toBe(402);
    expect(mapPassthroughUpstreamStatus(404)).toBe(404);
    expect(mapPassthroughUpstreamStatus(429)).toBe(429);
    // Upstream auth state is OUR key, never the caller's fault.
    expect(mapPassthroughUpstreamStatus(401)).toBe(503);
    expect(mapPassthroughUpstreamStatus(403)).toBe(503);
    expect(mapPassthroughUpstreamStatus(500)).toBe(503);
    expect(mapPassthroughUpstreamStatus(529)).toBe(503);
  });
});

describe("passthrough streaming — qualifying request pipes bytes verbatim and bills from the usage frame", () => {
  test("captures the preforward boundary immediately around the upstream fetch", async () => {
    const events: string[] = [];
    fetchImpl = async () => {
      events.push("fetch");
      return sseResponse(UPSTREAM_SSE);
    };

    const res = await callStreaming(async () => null, {
      providerDispatchTelemetry: {
        capture: () => events.push("capture"),
        emit: () => events.push("emit"),
      },
    });
    expect(events).toEqual(["capture", "fetch", "emit"]);
    await res.text();
  });

  test("bytes are piped verbatim, usage is billed, settle chain runs once", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    fetchImpl = async () => sseResponse(UPSTREAM_SSE);

    const res = await callStreaming(settle, {
      effectiveMaxTokens: 4096,
      request: { ...QUALIFYING_REQUEST, prompt_cache_key: "v5:stable-prefix" },
    });
    const body = await res.text();

    // Byte-for-byte pass-through: vendor fields, reasoning delta, upstream id,
    // frame order — all preserved exactly. The SDK path cannot produce this.
    expect(body).toBe(UPSTREAM_SSE);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("X-Eliza-Inference-Path")).toBe("passthrough");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    // The AI SDK was never involved.
    expect(streamText).not.toHaveBeenCalled();

    // Upstream fetch: normalized bare cerebras id, provider key, usage frame
    // requested, params forwarded on the OpenAI wire names.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-cerebras-key",
    );
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.model).toBe("gpt-oss-120b");
    expect(sentBody.stream).toBe(true);
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    expect(sentBody.max_tokens).toBe(4096);
    expect(sentBody.prompt_cache_key).toBe("v5:stable-prefix");
    expect(sentBody).not.toHaveProperty("promptCacheKey");
    expect(sentBody.messages).toEqual([{ role: "user", content: "hello" }]);

    // Billing: the terminal usage frame's tokens, through the real settler.
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(billUsage.mock.calls[0][1]).toMatchObject({
      inputTokens: 72,
      outputTokens: 60,
      totalTokens: 132,
      cacheReadInputTokens: 7,
    });
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(EXPECTED_COST, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - EXPECTED_COST, 10);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
    expect(aiBillingRecord).toHaveBeenCalledTimes(1);
  });

  test("usage-bearing passthrough keeps the admitted estimate when local billing fails", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    fetchImpl = async () => sseResponse(UPSTREAM_SSE);
    billUsage.mockRejectedValueOnce(new Error("pricing backend unavailable"));

    const res = await callStreaming(settle, {
      settleUnknown: () => settle(ledger.hold),
    });
    expect(await res.text()).toBe(UPSTREAM_SSE);

    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([ledger.hold]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - ledger.hold, 10);
  });

  test("bills with the same context and token amounts as the SDK path", async () => {
    // Fast path.
    fetchImpl = async () => sseResponse(UPSTREAM_SSE);
    const passthroughRes = await callStreaming(async () => null, {});
    await passthroughRes.text();
    expect(billUsage).toHaveBeenCalledTimes(1);
    const [passthroughContext, passthroughUsage] = billUsage.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, number>,
    ];

    // SDK path (flag off), same request, provider reporting the same tokens.
    billUsage.mockClear();
    process.env.INFERENCE_PASSTHROUGH_STREAMING = "false";
    sdkFaithfulStream({ ...USAGE_TOKENS });
    const sdkRes = await callStreaming(async () => null, {});
    await sdkRes.text();
    expect(billUsage).toHaveBeenCalledTimes(1);
    const [sdkContext, sdkUsage] = billUsage.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, number>,
    ];

    // Identical billing context (org, user, model, provider, source,
    // requestId, streaming flag, affiliate) and identical token amounts.
    expect(passthroughContext).toEqual(sdkContext);
    expect(passthroughUsage.inputTokens).toBe(sdkUsage.inputTokens);
    expect(passthroughUsage.outputTokens).toBe(sdkUsage.outputTokens);
    expect(passthroughUsage.totalTokens).toBe(sdkUsage.totalTokens);
  });

  test("forwards validated reasoning_effort and the exact disabled-reasoning cap", async () => {
    fetchImpl = async () => sseResponse(UPSTREAM_SSE);
    const model = "zai-glm-4.7";
    const res = await callStreaming(async () => null, {
      model,
      request: {
        model,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: "none",
      },
      effectiveMaxTokens: 512,
    });
    await res.text();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sentBody.model).toBe(model);
    expect(sentBody.reasoning_effort).toBe("none");
    expect(sentBody.max_tokens).toBe(512);
  });
});

describe("passthrough streaming — fallthrough to the SDK path", () => {
  const fallthroughCases: Array<[string, Parameters<typeof callStreaming>[1]]> =
    [
      [
        "tools present",
        {
          request: {
            ...(QUALIFYING_REQUEST as Record<string, unknown>),
            tools: [
              {
                type: "function",
                function: { name: "get_weather", parameters: {} },
              },
            ],
          },
        },
      ],
      [
        "response_format json_object",
        {
          request: {
            ...(QUALIFYING_REQUEST as Record<string, unknown>),
            response_format: { type: "json_object" },
          },
        },
      ],
      [
        "no stream_options.include_usage",
        {
          request: {
            model: MODEL,
            messages: [{ role: "user", content: "hello" }],
            stream: true,
          },
        },
      ],
      [
        "pooled BYO credential",
        {
          pooledCredential: {
            organizationId: ORG,
            credentialId: "pooled-credential-1",
            providerId: "cerebras-api",
            apiKey: "sk-pooled",
            label: "Team Cerebras key",
          },
        },
      ],
    ];

  for (const [name, options] of fallthroughCases) {
    test(`${name} → streamText path, upstream fetch never fired`, async () => {
      sdkFaithfulStream();
      const res = await callStreaming(async () => null, options);
      const body = await res.text();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(streamText).toHaveBeenCalledTimes(1);
      expect(body).toContain("Hello");
      expect(body.trimEnd().endsWith("data: [DONE]")).toBe(true);
      expect(res.headers.get("X-Eliza-Inference-Path")).toBeNull();
    });
  }

  test("flag off → SDK path even for a fully qualifying request", async () => {
    process.env.INFERENCE_PASSTHROUGH_STREAMING = "false";
    sdkFaithfulStream();

    const res = await callStreaming(async () => null, {});
    const body = await res.text();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(body).toContain("Hello");
    expect(res.headers.get("X-Eliza-Inference-Path")).toBeNull();
  });

  test("SDK streaming preserves prompt_cache_key alongside reasoning_effort", async () => {
    sdkFaithfulStream();
    const model = "zai-glm-4.7";
    const promptCacheKey = "v5:reasoning-prefix";
    const res = await callStreaming(async () => null, {
      model,
      request: {
        model,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
        stream_options: { include_usage: true },
        reasoning_effort: "none",
        prompt_cache_key: promptCacheKey,
        tools: [
          {
            type: "function",
            function: { name: "get_weather", parameters: {} },
          },
        ],
      },
      effectiveMaxTokens: 512,
    });
    await res.text();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(streamText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 512,
      providerOptions: {
        openai: { promptCacheKey, reasoningEffort: "none" },
      },
    });
  });

  test("SDK non-streaming preserves prompt_cache_key alongside reasoning_effort", async () => {
    generateTextImpl = () => ({
      text: "Hello",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 72, outputTokens: 1, totalTokens: 73 },
    });

    const promptCacheKey = "v5:reasoning-prefix";
    const res = await callNonStreaming("zai-glm-4.7", "none", promptCacheKey);
    expect(res.status).toBe(200);
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(generateText.mock.calls[0]?.[0]).toMatchObject({
      maxOutputTokens: 512,
      providerOptions: {
        openai: { promptCacheKey, reasoningEffort: "none" },
      },
    });
  });

  test("SDK non-streaming keeps the admitted estimate when billing fails after provider output", async () => {
    generateTextImpl = () => ({
      text: "Hello",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 72, outputTokens: 1, totalTokens: 73 },
    });
    billUsage.mockRejectedValueOnce(new Error("pricing backend unavailable"));
    const actualSettles: number[] = [];
    let unknownSettles = 0;

    const res = await callNonStreaming("zai-glm-4.7", "none", undefined, {
      settle: async (actualCost) => {
        actualSettles.push(actualCost);
        return null;
      },
      settleUnknown: async () => {
        unknownSettles++;
        return null;
      },
    });

    expect(res.status).toBe(200);
    expect(unknownSettles).toBe(1);
    expect(actualSettles).toEqual([]);
  });

  test("missing provider key → SDK path (no half-configured passthrough)", async () => {
    delete process.env.CEREBRAS_API_KEY;
    sdkFaithfulStream();

    const res = await callStreaming(async () => null, {});
    await res.text();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(streamText).toHaveBeenCalledTimes(1);
  });
});

describe("passthrough streaming — client abort cancels upstream and settles the delivered portion", () => {
  test("response cancellation stops the meter and completes deferred settlement", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    const deliveredText = "partial response before disconnect";
    const waitUntilPromises: Promise<unknown>[] = [];
    let upstreamCancelled = false;

    fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: {"id":"c1","choices":[{"index":0,"delta":{"content":${JSON.stringify(deliveredText)}},"finish_reason":null}],"usage":null}\n\n`,
              ),
            );
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        { status: 200 },
      );

    const res = await callStreaming(settle, {
      estimatedInputTokens: 9,
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("expected passthrough response body");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(deliveredText);

    await reader.cancel(new DOMException("client disconnected", "AbortError"));
    await Promise.all(waitUntilPromises);

    expect(upstreamCancelled).toBe(true);
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(billUsage.mock.calls[0][1]).toMatchObject({
      inputTokens: 9,
      outputTokens: estimateTokens(deliveredText),
    });
    expect(ledger.reconcileCalls).toBe(1);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
  });

  test("abort mid-stream: upstream signal aborted, estimate-based partial settle", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    const abortController = new AbortController();
    const estimatedInputTokens = 12;
    const deliveredText = "partial response already sent";
    const expectedCost =
      estimatedInputTokens * INPUT_TOKEN_COST +
      estimateTokens(deliveredText) * OUTPUT_TOKEN_COST;

    let upstreamSignal: AbortSignal | undefined;
    fetchImpl = async (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: {"id":"c1","choices":[{"index":0,"delta":{"content":${JSON.stringify(deliveredText)}},"finish_reason":null}],"usage":null}\n\n`,
              ),
            );
            // Client disconnect: the request signal fires, which must
            // propagate to the upstream fetch; the upstream read then fails.
            setTimeout(() => {
              abortController.abort();
              controller.error(
                new DOMException("The operation was aborted.", "AbortError"),
              );
            }, 10);
          },
        }),
        { status: 200 },
      );
    };

    const res = await callStreaming(settle, {
      estimatedInputTokens,
      signal: abortController.signal,
    });
    // The client branch errors with the upstream abort; the settle already ran
    // inline (no executionCtx) before the response was returned.
    await res.text().catch(() => undefined);

    // AbortSignal pass-through: the composed upstream signal observed the abort.
    expect(upstreamSignal).toBeDefined();
    expect(upstreamSignal?.aborted).toBe(true);

    // Estimate-based settle, exactly like the SDK path's onAbort.
    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(billUsage.mock.calls[0][1]).toMatchObject({
      inputTokens: estimatedInputTokens,
      outputTokens: estimateTokens(deliveredText),
    });
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(expectedCost, 10);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - expectedCost, 10);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
  });

  test("stream that terminates without a usage frame settles from estimates, never free", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    const deliveredText = "no usage frame from provider";
    fetchImpl = async () =>
      sseResponse(
        `data: {"id":"c1","choices":[{"index":0,"delta":{"content":${JSON.stringify(deliveredText)}},"finish_reason":"stop"}],"usage":null}\n\n` +
          `data: [DONE]\n\n`,
      );

    const res = await callStreaming(settle, { estimatedInputTokens: 5 });
    await res.text();

    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(
      5 * INPUT_TOKEN_COST + estimateTokens(deliveredText) * OUTPUT_TOKEN_COST,
      10,
    );
  });
});

describe("passthrough streaming — upstream errors settle by provable outcome", () => {
  test("upstream 429 surfaces as 429 rate_limit_error with the upstream message; hold refunded", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          error: { message: "queue is saturated", type: "rate_limit_error" },
        }),
        { status: 429 },
      );

    const res = await callStreaming(settle, {});
    expect(res.status).toBe(429);
    const json = (await res.json()) as {
      error: { message: string; type: string; code: number };
    };
    expect(json.error.type).toBe("rate_limit_error");
    expect(json.error.code).toBe(429);
    expect(json.error.message).toBe("queue is saturated");

    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([0]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
    expect(billUsage).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  test("redacts an echoed prompt cache key from an upstream error", async () => {
    const promptCacheKey = "opaque-cache-key-secret";
    fetchImpl = async () =>
      Response.json(
        {
          error: {
            message: `prompt cache key ${promptCacheKey} is invalid`,
            type: "invalid_request_error",
          },
        },
        { status: 400 },
      );

    const res = await callStreaming(async () => null, {
      request: { ...QUALIFYING_REQUEST, prompt_cache_key: promptCacheKey },
    });
    const body = await res.text();

    expect(res.status).toBe(400);
    expect(body).toContain("[REDACTED_PROMPT_CACHE_KEY]");
    expect(body).not.toContain(promptCacheKey);
  });

  test("upstream 500 surfaces as 503 and retains the estimate as an ambiguous outcome", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    fetchImpl = async () =>
      new Response("internal provider explosion", { status: 500 });

    const res = await callStreaming(settle, {
      settleUnknown: () => settle(ledger.hold),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: { type: string } };
    expect(json.error.type).toBe("service_unavailable");
    expect(ledger.actualCosts).toEqual([ledger.hold]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - ledger.hold, 10);
  });

  test("upstream 401 maps to 503 and never leaks the upstream auth body", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          error: { message: "invalid api key sk-secret-platform-key" },
        }),
        { status: 401 },
      );

    const res = await callStreaming(settle, {});
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).not.toContain("sk-secret-platform-key");
    expect(ledger.actualCosts).toEqual([0]);
  });

  test("ambiguous upstream fetch failure surfaces 503 and retains the estimate", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    fetchImpl = async () => {
      throw new TypeError("network down");
    };

    const res = await callStreaming(settle, {
      settleUnknown: () => settle(ledger.hold),
    });
    expect(res.status).toBe(503);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([ledger.hold]);
    expect(billUsage).not.toHaveBeenCalled();
  });

  test("dispatch acknowledgement failure cancels before the provider is invoked", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    let unknownSettles = 0;
    fetchImpl = async () => {
      throw new Error("provider fetch must not run");
    };

    const res = await callStreaming(settle, {
      markProviderDispatched: async () => {
        throw new InferenceAdmissionDispatchMarkError(
          "dispatch acknowledgement remained ambiguous",
        );
      },
      settleUnknown: async () => {
        unknownSettles++;
        return null;
      },
    });

    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unknownSettles).toBe(0);
    expect(ledger.actualCosts).toEqual([0]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance, 10);
  });

  test("partial output followed by an in-stream error retains the admitted estimate", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);
    fetchImpl = async () =>
      sseResponse(
        `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}],"usage":null}\n\n` +
          `data: {"error":{"message":"model overloaded","type":"overloaded_error"}}\n\n` +
          `data: [DONE]\n\n`,
      );

    const res = await callStreaming(settle, {
      settleUnknown: () => settle(ledger.hold),
    });
    await res.text();

    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts).toEqual([ledger.hold]);
    expect(ledger.balance).toBeCloseTo(ledger.startBalance - ledger.hold, 10);
    expect(billUsage).not.toHaveBeenCalled();
  });
});

describe("passthrough streaming — settlement runs OFF the response path via waitUntil", () => {
  test("client bytes flush while billUsage is gated; the deferred chain settles once", async () => {
    const ledger = makeLedgerReservation(100, 0.9);
    const settle = createCreditReservationSettler(ledger.reservation);

    let releaseBilling!: () => void;
    billUsageGate = new Promise<void>((resolve) => {
      releaseBilling = resolve;
    });
    const waitUntilPromises: Promise<unknown>[] = [];
    fetchImpl = async () => sseResponse(UPSTREAM_SSE);

    const res = await callStreaming(settle, {
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    // The whole piped body reads to [DONE] while the settle chain is still
    // blocked at billUsage — billing never holds the bytes hostage.
    const body = await res.text();
    expect(body).toBe(UPSTREAM_SSE);
    expect(ledger.reconcileCalls).toBe(0);
    expect(waitUntilPromises).toHaveLength(1);
    let deferredSettled = false;
    void waitUntilPromises[0].finally(() => {
      deferredSettled = true;
    });
    await Promise.resolve();
    expect(deferredSettled).toBe(false);

    releaseBilling();
    await Promise.all(waitUntilPromises);
    expect(deferredSettled).toBe(true);

    expect(billUsage).toHaveBeenCalledTimes(1);
    expect(ledger.reconcileCalls).toBe(1);
    expect(ledger.actualCosts[0]).toBeCloseTo(EXPECTED_COST, 10);
    expect(recordUsageAnalytics).toHaveBeenCalledTimes(1);
    expect(aiBillingRecord).toHaveBeenCalledTimes(1);
  });
});

describe("passthrough streaming — #16079 milestone telemetry", () => {
  test("emits Server-Timing upstream_headers, provider request id echo, and a correlated ring-buffer event", async () => {
    fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(UPSTREAM_SSE));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "x-request-id": "req-abc_123-xyz",
          },
        },
      );

    const res = await callStreaming(async () => null, {});
    await res.text();

    // Response carries the provider-leg boundaries and the bounded echo.
    const serverTiming = res.headers.get("Server-Timing") ?? "";
    expect(serverTiming).toMatch(/^upstream_headers;dur=[0-9.]+$/);
    expect(res.headers.get("X-Eliza-Provider-Request-Id")).toBe(
      "req-abc_123-xyz",
    );

    // The always-on ring buffer holds one correlated event keyed by the
    // fallback trace id (the test harness's requestId) with the milestones
    // the teed meter observed from the upstream SSE bytes.
    const snapshot = getCloudTelemetrySnapshot(10);
    const event = snapshot.streamMilestones.find(
      (e) => e.path === "passthrough",
    );
    if (!event) throw new Error("no passthrough milestone event recorded");
    expect(event.requestId).toBe("req-1");
    expect(event.traceId).toBe("req-1");
    expect(event.model).toBe(MODEL);
    expect(event.providerRequestId).toBe("req-abc_123-xyz");
    expect(event.upstreamHeadersMs).not.toBeUndefined();
    expect(event.upstreamHeadersMs).toBeGreaterThanOrEqual(0);
    // UPSTREAM_SSE's first frame carries content + reasoning in one delta.
    expect(event.firstEventMs).not.toBeNull();
    expect(event.firstReasoningMs).not.toBeNull();
    expect(event.firstContentMs).not.toBeNull();
    expect(event.completionMs).not.toBeNull();
    expect(event.aborted).toBe(false);
  });

  test("sanitizes an unsafe provider request id and omits the echo when absent", async () => {
    fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(UPSTREAM_SSE));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "x-request-id": 'bad"id with spaces and <script>',
          },
        },
      );
    const res = await callStreaming(async () => null, {});
    await res.text();
    // Only safe token characters survive; quotes/angles/spaces are replaced.
    expect(res.headers.get("X-Eliza-Provider-Request-Id")).toBe(
      "bad_id_with_spaces_and__script_",
    );

    // Absent upstream x-request-id → the echo header is OMITTED entirely, not
    // emitted empty, and the ring event carries no providerRequestId field.
    fetchImpl = async () => sseResponse(UPSTREAM_SSE);
    const bareRes = await callStreaming(async () => null, {});
    await bareRes.text();
    expect(bareRes.headers.get("X-Eliza-Provider-Request-Id")).toBeNull();
    const snapshot = getCloudTelemetrySnapshot(10);
    const event = snapshot.streamMilestones.find(
      (e) => e.path === "passthrough",
    );
    if (!event) throw new Error("no passthrough milestone event recorded");
    expect(event.providerRequestId).toBeUndefined();
    // The rest of the event is still healthy without the provider id.
    expect(event.upstreamHeadersMs).not.toBeUndefined();
    expect(event.completionMs).not.toBeNull();
  });

  test("clean SSE error frame then close records aborted=true and no completion", async () => {
    // RP round-1 finding: a provider that reports failure mid-stream and then
    // closes cleanly must NOT be recorded as a healthy completed run.
    fetchImpl = async () =>
      sseResponse(
        `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}],"usage":null}\n\n` +
          `data: {"error":{"message":"model overloaded","type":"overloaded_error"}}\n\n`,
      );

    const res = await callStreaming(async () => null, {});
    await res.text();

    const snapshot = getCloudTelemetrySnapshot(10);
    const event = snapshot.streamMilestones.find(
      (e) => e.path === "passthrough",
    );
    if (!event) throw new Error("no passthrough milestone event recorded");
    // Observed partial milestones survive…
    expect(event.firstContentMs).not.toBeNull();
    // …but the run is recorded as failed: aborted=true, completionMs null.
    expect(event.aborted).toBe(true);
    expect(event.completionMs).toBeNull();
  });

  test("milestone origin excludes the dispatch-marker latency", async () => {
    // RP round-2 finding 2: the provider-leg clock must start AFTER the
    // (potentially slow) Durable-Object dispatch acknowledgement, immediately
    // before fetch(). A marker delayed by 60ms must not inflate
    // upstreamHeadersMs — with the origin correctly placed, the instant mock
    // fetch keeps it far below the marker delay.
    const MARKER_DELAY_MS = 60;
    fetchImpl = async () => sseResponse(UPSTREAM_SSE);
    const res = await callStreaming(async () => null, {
      markProviderDispatched: () =>
        new Promise<void>((resolve) => setTimeout(resolve, MARKER_DELAY_MS)),
    });
    await res.text();

    const snapshot = getCloudTelemetrySnapshot(10);
    const event = snapshot.streamMilestones.find(
      (e) => e.path === "passthrough",
    );
    if (!event) throw new Error("no passthrough milestone event recorded");
    expect(event.upstreamHeadersMs).not.toBeUndefined();
    // If the origin were captured before the marker await (the round-1 bug),
    // upstreamHeadersMs would be >= 60. Half the delay is a safe bound that
    // still separates the two placements by an order of magnitude.
    expect(event.upstreamHeadersMs).toBeLessThan(MARKER_DELAY_MS / 2);
    expect(event.completionMs).not.toBeNull();
  });

  test("client-branch cancel records aborted=true with partial milestones", async () => {
    // RP round-1 finding: the existing abort test simulated an upstream read
    // error; this one cancels the CLIENT branch mid-stream, exercising the
    // cancel() → meterAbortController.abort() path a real disconnect takes.
    const deliveredText = "partial before disconnect";
    const waitUntilPromises: Array<Promise<unknown>> = [];

    fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: {"id":"c1","choices":[{"index":0,"delta":{"content":${JSON.stringify(deliveredText)}},"finish_reason":null}],"usage":null}\n\n`,
              ),
            );
            // No close: the provider is still streaming when the client drops.
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );

    const res = await callStreaming(async () => null, {
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("expected passthrough response body");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(deliveredText);
    await reader.cancel(new DOMException("client disconnected", "AbortError"));
    await Promise.all(waitUntilPromises);

    const snapshot = getCloudTelemetrySnapshot(10);
    const event = snapshot.streamMilestones.find(
      (e) => e.path === "passthrough",
    );
    if (!event) throw new Error("no passthrough milestone event recorded");
    // The client disconnect reached the meter branch: the run is aborted with
    // the partial content milestone observed, never a completion.
    expect(event.aborted).toBe(true);
    expect(event.firstContentMs).not.toBeNull();
    expect(event.completionMs).toBeNull();
  });

  test("aborted stream records aborted=true and keeps observed partial milestones", async () => {
    // Upstream that errors mid-stream after delivering one content frame.
    fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n`,
              ),
            );
            controller.error(new Error("upstream dropped mid-stream"));
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );

    const res = await callStreaming(async () => null, {});
    // Drain what the client branch will deliver; the read failure propagates.
    await res.text().catch(() => undefined);
    // The settle chain runs inline (no executionCtx); give the microtasks a
    // beat to complete the meter drain.
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = getCloudTelemetrySnapshot(10);
    const event = snapshot.streamMilestones.find(
      (e) => e.path === "passthrough",
    );
    if (!event) throw new Error("no passthrough milestone event recorded");
    // An errored source discards queued chunks (whatwg streams), so mid-stream
    // milestones may legitimately be null here — what MUST hold: the event
    // exists, is marked aborted, and never claims a completion it did not
    // observe. The fan-out meter sees exactly the chunks the client saw.
    expect(event.aborted).toBe(true);
    expect(event.completionMs).toBeNull();
  });

  test("clean EOF without [DONE] records aborted=true and no completion (#20032)", async () => {
    // A truncated OpenAI-compatible stream (connection closed before the
    // protocol terminal) must be distinguishable from a completed one.
    fetchImpl = async () =>
      sseResponse(
        `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"cut "},"finish_reason":null}],"usage":null}\n\n`,
      );

    const res = await callStreaming(async () => null, {});
    expect(await res.text()).toContain("cut ");

    const snapshot = getCloudTelemetrySnapshot(10);
    const event = snapshot.streamMilestones.find(
      (e) => e.path === "passthrough",
    );
    if (!event) throw new Error("no passthrough milestone event recorded");
    expect(event.firstContentMs).not.toBeNull();
    expect(event.aborted).toBe(true);
    expect(event.completionMs).toBeNull();
  });

  test("upstream pulling is bounded by client backpressure — no tee queue (#20032)", async () => {
    // With `tee()`, the fast meter branch drove upstream pulls while a slow
    // client's branch queued every chunk unbounded. The single-reader fan-out
    // pulls only when the client reads: a stalled client stalls the upstream.
    const TOTAL_CHUNKS = 200;
    let pulled = 0;
    fetchImpl = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulled >= TOTAL_CHUNKS) {
              controller.close();
              return;
            }
            pulled += 1;
            controller.enqueue(
              encoder.encode(
                `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}],"usage":null}\n\n`,
              ),
            );
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );

    const waitUntilPromises: Array<Promise<unknown>> = [];
    const res = await callStreaming(async () => null, {
      executionCtx: {
        waitUntil(promise: Promise<unknown>) {
          waitUntilPromises.push(promise);
        },
      },
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("expected passthrough response body");
    // Read one chunk, then stall the client entirely.
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 25));
    // Bounded: the upstream advanced only by the client's single read plus
    // small fixed internal queues — never anywhere near the full stream.
    expect(pulled).toBeLessThan(10);
    expect(pulled).toBeLessThan(TOTAL_CHUNKS);
    await reader.cancel(new DOMException("client stalled out", "AbortError"));
    await Promise.all(waitUntilPromises);

    const snapshot = getCloudTelemetrySnapshot(10);
    const event = snapshot.streamMilestones.find(
      (e) => e.path === "passthrough",
    );
    if (!event) throw new Error("no passthrough milestone event recorded");
    expect(event.aborted).toBe(true);
    expect(event.completionMs).toBeNull();
  });
});
