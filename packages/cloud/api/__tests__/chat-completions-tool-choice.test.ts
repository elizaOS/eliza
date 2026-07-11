/**
 * Pure-helper tests for v1/chat/completions/route.ts's tool_choice + tools
 * mappers. These exercise the AI-SDK shape conversion that runs before
 * generateText/streamText, and prevent regressions of the
 * `mapToolChoice("required")` crash — `"required"` is a valid OpenAI-API
 * value (and the elizaOS planner sends it for forced-tool turns), but the
 * pre-fix code only early-returned on "auto" / "none" and fell through to
 * `toolChoice.function.name`, which is undefined on a string and produced
 * a 500 with body `{"error":{"message":"Cannot read properties of
 * undefined (reading 'name')"...}}`.
 *
 * Route-level happy-path / auth scenarios live in test/e2e — these are
 * pure and run without I/O.
 */

import { describe, expect, test } from "bun:test";

import {
  __nativeToolingTestHooks,
  __passthroughStreamingTestHooks,
  __streamingCreditTestHooks,
} from "../v1/chat/completions/route";

const {
  mapToolChoice,
  convertTools,
  computeEffectiveMaxTokens,
  validateCerebrasReasoningEffort,
  buildReasoningEffortProviderOptions,
  isEmptyButBilled,
  toOpenAiFinishReason,
  resolvePromptCacheKey,
  mergePromptCacheProviderOptions,
} = __nativeToolingTestHooks;
const { getRecoverableProviderErrorStatus } = __streamingCreditTestHooks;
const { qualifiesForPassthroughStreaming, mapPassthroughUpstreamStatus } =
  __passthroughStreamingTestHooks;

// Mirror of MIN_RESPONSE_TOKENS in route.ts. Kept as a literal here so the test
// fails loudly if the production floor changes without intent.
const MIN_RESPONSE_TOKENS = 4096;

describe("mapToolChoice", () => {
  test("returns undefined when toolChoice is undefined", () => {
    expect(mapToolChoice(undefined)).toBeUndefined();
  });

  test('returns "auto" unchanged', () => {
    expect(mapToolChoice("auto")).toBe("auto");
  });

  test('returns "none" unchanged', () => {
    expect(mapToolChoice("none")).toBe("none");
  });

  test('returns "required" unchanged (regression: pre-fix crashed with "Cannot read properties of undefined (reading \'name\')")', () => {
    // This is the regression. The OpenAI API and the AI SDK both accept
    // tool_choice: "required" to force the model to call some tool. The
    // elizaOS planner sends it for forced-tool turns (services/message.ts).
    // Before the fix, this fell through to `toolChoice.function.name` and
    // crashed because `"required".function` is undefined.
    expect(mapToolChoice("required")).toBe("required");
  });

  test("maps explicit function selection to AI-SDK { type: tool, toolName } shape", () => {
    expect(
      mapToolChoice({ type: "function", function: { name: "search_web" } }),
    ).toEqual({ type: "tool", toolName: "search_web" });
  });
});

describe("convertTools", () => {
  test("returns undefined when tools is undefined", () => {
    expect(convertTools(undefined)).toBeUndefined();
  });

  test("returns undefined when tools is an empty array", () => {
    expect(convertTools([])).toBeUndefined();
  });

  test("maps a single OpenAI-shaped tool to an AI-SDK tool record keyed by name", () => {
    const out = convertTools([
      {
        type: "function",
        function: {
          name: "search_web",
          description: "Search the web for a query.",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      },
    ]);

    expect(out).toBeDefined();
    const tool = out?.search_web;
    expect(tool).toBeDefined();
    expect(tool?.description).toBe("Search the web for a query.");
    // inputSchema / outputSchema are AI-SDK JSONSchema wrappers; we just
    // assert their presence rather than walk their internal shape.
    expect(tool?.inputSchema).toBeDefined();
    expect(tool?.outputSchema).toBeDefined();
  });

  test("omits description when tool has none", () => {
    const out = convertTools([
      { type: "function", function: { name: "noop" } },
    ]);
    expect(out?.noop).toBeDefined();
    expect(out?.noop).not.toHaveProperty("description");
  });
});

/**
 * computeEffectiveMaxTokens preserves an explicit caller output/spend ceiling.
 * Reasoning models receive a safer default only when max_tokens is omitted.
 */
describe("computeEffectiveMaxTokens", () => {
  test("non-reasoning model: passes request max_tokens through unchanged", () => {
    expect(computeEffectiveMaxTokens(10, null, "openai/gpt-4o-mini")).toBe(10);
    expect(computeEffectiveMaxTokens(512, null, "openai/gpt-4o-mini")).toBe(
      512,
    );
  });

  test("non-reasoning model: leaves undefined max_tokens undefined", () => {
    expect(
      computeEffectiveMaxTokens(undefined, null, "openai/gpt-4o-mini"),
    ).toBeUndefined();
  });

  test("reasoning model: preserves an explicit tiny max_tokens ceiling", () => {
    expect(computeEffectiveMaxTokens(10, null, "minimax/minimax-m3")).toBe(10);
    expect(computeEffectiveMaxTokens(16, null, "deepseek/deepseek-r1")).toBe(
      16,
    );
  });

  test("reasoning model with no max_tokens: floors to MIN_RESPONSE_TOKENS", () => {
    expect(computeEffectiveMaxTokens(undefined, null, "openai/o3-mini")).toBe(
      MIN_RESPONSE_TOKENS,
    );
  });

  test("reasoning model with generous max_tokens: honors the larger request", () => {
    expect(computeEffectiveMaxTokens(8000, null, "minimax/minimax-m3")).toBe(
      8000,
    );
  });

  test("reasoning disabled: preserves the caller's exact max_tokens", () => {
    expect(
      computeEffectiveMaxTokens(260, null, "zai-glm-4.7", undefined, "none"),
    ).toBe(260);
    expect(
      computeEffectiveMaxTokens(
        512,
        null,
        "cerebras:gemma-4-31b",
        undefined,
        "none",
      ),
    ).toBe(512);
  });

  test("Gemma's omitted reasoning_effort uses its no-reasoning default", () => {
    expect(computeEffectiveMaxTokens(512, null, "gemma-4-31b")).toBe(512);
  });

  test("active Cerebras reasoning preserves an explicit caller ceiling", () => {
    expect(
      computeEffectiveMaxTokens(512, null, "gemma-4-31b", undefined, "low"),
    ).toBe(512);
    expect(computeEffectiveMaxTokens(512, null, "zai-glm-4.7")).toBe(512);
    expect(
      computeEffectiveMaxTokens(512, null, "gpt-oss-120b", undefined, "low"),
    ).toBe(512);
  });

  test("active Cerebras reasoning floors omitted max_tokens to the response-token floor", () => {
    expect(
      computeEffectiveMaxTokens(
        undefined,
        null,
        "gemma-4-31b",
        undefined,
        "low",
      ),
    ).toBe(MIN_RESPONSE_TOKENS);
    expect(computeEffectiveMaxTokens(undefined, null, "zai-glm-4.7")).toBe(
      MIN_RESPONSE_TOKENS,
    );
    expect(
      computeEffectiveMaxTokens(
        undefined,
        null,
        "gpt-oss-120b",
        undefined,
        "low",
      ),
    ).toBe(MIN_RESPONSE_TOKENS);
  });

  test("Anthropic CoT budget: preserves an explicit caller ceiling", () => {
    expect(
      computeEffectiveMaxTokens(1000, 8000, "anthropic/claude-opus-4.8"),
    ).toBe(1000);
  });

  test("Anthropic CoT budget: reserves response capacity when max_tokens is omitted", () => {
    expect(
      computeEffectiveMaxTokens(undefined, 8000, "anthropic/claude-opus-4.8"),
    ).toBe(8000 + MIN_RESPONSE_TOKENS);
  });

  test("Anthropic CoT budget: honors a larger requested max_tokens", () => {
    expect(
      computeEffectiveMaxTokens(20000, 8000, "anthropic/claude-opus-4.8"),
    ).toBe(20000);
  });

  test("catalog reasoning signal: preserves explicit max_tokens", () => {
    // glm-5.1 / kimi-k2.6 / deepseek-v4-pro have no "think"/"reasoning" id but
    // advertise reasoning in supported_parameters.
    expect(
      computeEffectiveMaxTokens(50, null, "z-ai/glm-5.1", [
        "max_tokens",
        "reasoning",
      ]),
    ).toBe(50);
    expect(
      computeEffectiveMaxTokens(50, null, "deepseek/deepseek-v4-pro", [
        "max_tokens",
        "include_reasoning",
      ]),
    ).toBe(50);
  });

  test("catalog reasoning signal: defaults omitted max_tokens to the safe floor", () => {
    expect(
      computeEffectiveMaxTokens(undefined, null, "z-ai/glm-5.1", [
        "max_tokens",
        "reasoning",
      ]),
    ).toBe(MIN_RESPONSE_TOKENS);
  });

  test("catalog non-reasoning signal: passes small max_tokens through", () => {
    expect(
      computeEffectiveMaxTokens(50, null, "openai/gpt-4o-mini", [
        "max_tokens",
        "temperature",
      ]),
    ).toBe(50);
  });
});

describe("Cerebras reasoning_effort validation", () => {
  test.each([
    ["gemma-4-31b", "none"],
    ["gemma-4-31b", "low"],
    ["gemma-4-31b", "medium"],
    ["gemma-4-31b", "high"],
    ["gpt-oss-120b", "low"],
    ["gpt-oss-120b", "medium"],
    ["gpt-oss-120b", "high"],
    ["zai-glm-4.7", "none"],
  ] as const)("accepts %s reasoning_effort=%s", (model, effort) => {
    expect(validateCerebrasReasoningEffort(model, effort)).toEqual({
      ok: true,
      value: effort,
    });
  });

  test("canonicalizes decorated Cerebras ids before validation", () => {
    expect(
      validateCerebrasReasoningEffort("openai/gpt-oss-120b:nitro", "high"),
    ).toEqual({ ok: true, value: "high" });
  });

  test.each([undefined, null])("treats %s as provider default", (effort) => {
    expect(validateCerebrasReasoningEffort("zai-glm-4.7", effort)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test.each([
    ["zai-glm-4.7", "low"],
    ["gpt-oss-120b", "none"],
    ["gemma-4-31b", "minimal"],
    ["gemma-4-31b", 1],
  ])("rejects %s reasoning_effort=%s", (model, effort) => {
    expect(validateCerebrasReasoningEffort(model, effort)).toMatchObject({
      ok: false,
    });
  });

  test("rejects reasoning_effort for a non-Cerebras model", () => {
    expect(
      validateCerebrasReasoningEffort("openai/gpt-4o-mini", "low"),
    ).toMatchObject({ ok: false });
  });

  test("builds the AI SDK provider option that maps to wire reasoning_effort", () => {
    expect(buildReasoningEffortProviderOptions("none")).toEqual({
      providerOptions: { openai: { reasoningEffort: "none" } },
    });
    expect(buildReasoningEffortProviderOptions(undefined)).toEqual({});
  });
});

describe("isEmptyButBilled", () => {
  test("detects a streamed reasoning completion with billed output but no visible result", () => {
    expect(isEmptyButBilled("", false, { outputTokens: 32 })).toBe(true);
    expect(isEmptyButBilled("", false, { completionTokens: 32 })).toBe(true);
  });

  test("does not override visible text, tool calls, or genuinely empty usage", () => {
    expect(isEmptyButBilled("answer", false, { outputTokens: 32 })).toBe(false);
    expect(isEmptyButBilled("", true, { outputTokens: 32 })).toBe(false);
    expect(isEmptyButBilled("", false, { outputTokens: 0 })).toBe(false);
  });

  test("preserves a provider-declared content-filter result", () => {
    expect(
      isEmptyButBilled("", false, { outputTokens: 32 }, "content-filter"),
    ).toBe(false);
    expect(
      isEmptyButBilled("", false, { completionTokens: 32 }, "content_filter"),
    ).toBe(false);
  });
});

describe("toOpenAiFinishReason", () => {
  test("maps AI-SDK finish reasons to valid OpenAI enum values", () => {
    // The streaming path used to emit these raw — "content-filter" (hyphen),
    // "error", "unknown" are NOT OpenAI values and break strict clients.
    expect(toOpenAiFinishReason("content-filter")).toBe("content_filter");
    expect(toOpenAiFinishReason("tool-calls")).toBe("tool_calls");
    expect(toOpenAiFinishReason("length")).toBe("length");
    expect(toOpenAiFinishReason("stop")).toBe("stop");
  });

  test("collapses unknown / error / undefined reasons to 'stop'", () => {
    expect(toOpenAiFinishReason("error")).toBe("stop");
    expect(toOpenAiFinishReason("unknown")).toBe("stop");
    expect(toOpenAiFinishReason("other")).toBe("stop");
    expect(toOpenAiFinishReason(undefined)).toBe("stop");
  });

  test("passes through already-normalized values idempotently", () => {
    expect(toOpenAiFinishReason("tool_calls")).toBe("tool_calls");
    expect(toOpenAiFinishReason("content_filter")).toBe("content_filter");
  });
});

describe("getRecoverableProviderErrorStatus", () => {
  function gatewayError(name: string, statusCode?: number) {
    return Object.assign(new Error(`${name} from gateway`), {
      name,
      ...(statusCode === undefined ? {} : { statusCode }),
    });
  }

  test("preserves gateway caller-fault statuses from stable error names", () => {
    expect(
      getRecoverableProviderErrorStatus(
        gatewayError("GatewayInvalidRequestError"),
      ),
    ).toBe(400);
    expect(
      getRecoverableProviderErrorStatus(
        gatewayError("GatewayModelNotFoundError"),
      ),
    ).toBe(404);
    expect(
      getRecoverableProviderErrorStatus(gatewayError("GatewayRateLimitError")),
    ).toBe(429);
  });

  test("preserves explicit gateway caller-fault status fields", () => {
    expect(
      getRecoverableProviderErrorStatus(gatewayError("GatewayError", 400)),
    ).toBe(400);
    expect(
      getRecoverableProviderErrorStatus(gatewayError("GatewayError", 404)),
    ).toBe(404);
    expect(
      getRecoverableProviderErrorStatus(gatewayError("GatewayError", 429)),
    ).toBe(429);
  });

  test("maps quota language to rate limit and leaves infrastructure errors to the boundary", () => {
    expect(
      getRecoverableProviderErrorStatus(new Error("provider quota exceeded")),
    ).toBe(429);
    expect(
      getRecoverableProviderErrorStatus(
        gatewayError("GatewayResponseError", 500),
      ),
    ).toBeNull();
  });
});

describe("passthrough streaming qualification", () => {
  function passthroughRequest(overrides: Record<string, unknown> = {}) {
    return {
      model: "openai/gpt-4o-mini",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user" as const, content: "hello" }],
      ...overrides,
    };
  }

  test("accepts the plain streamed chat shape that can be piped byte-for-byte", () => {
    expect(qualifiesForPassthroughStreaming(passthroughRequest())).toBe(true);
    expect(
      qualifiesForPassthroughStreaming({
        ...passthroughRequest(),
        response_format: { type: "text" },
      }),
    ).toBe(true);
  });

  test("rejects shapes that require route-side SSE synthesis or provider options", () => {
    expect(
      qualifiesForPassthroughStreaming({
        ...passthroughRequest(),
        stream: false,
      }),
    ).toBe(false);
    expect(
      qualifiesForPassthroughStreaming({
        ...passthroughRequest(),
        stream_options: { include_usage: false },
      }),
    ).toBe(false);
    expect(
      qualifiesForPassthroughStreaming({
        ...passthroughRequest(),
        tools: [{ type: "function", function: { name: "search" } }],
      }),
    ).toBe(false);
    expect(
      qualifiesForPassthroughStreaming({
        ...passthroughRequest(),
        tool_choice: "required",
      }),
    ).toBe(false);
    expect(
      qualifiesForPassthroughStreaming({
        ...passthroughRequest(),
        response_format: { type: "json_object" },
      }),
    ).toBe(false);
    expect(
      qualifiesForPassthroughStreaming({
        ...passthroughRequest(),
        webSearchEnabled: true,
      }),
    ).toBe(false);
  });

  test("rejects message shapes whose semantics must be converted by the route", () => {
    expect(
      qualifiesForPassthroughStreaming({
        ...passthroughRequest(),
        messages: [{ role: "tool", content: "result", tool_call_id: "call-1" }],
      }),
    ).toBe(false);
    expect(
      qualifiesForPassthroughStreaming({
        ...passthroughRequest(),
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
        ],
      }),
    ).toBe(false);
    expect(
      qualifiesForPassthroughStreaming({
        ...passthroughRequest(),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "multimodal part" }],
          },
        ],
      }),
    ).toBe(false);
  });
});

describe("mapPassthroughUpstreamStatus", () => {
  test("passes caller-fault statuses through and hides provider auth/infra state", () => {
    expect(mapPassthroughUpstreamStatus(400)).toBe(400);
    expect(mapPassthroughUpstreamStatus(402)).toBe(402);
    expect(mapPassthroughUpstreamStatus(404)).toBe(404);
    expect(mapPassthroughUpstreamStatus(429)).toBe(429);
    expect(mapPassthroughUpstreamStatus(401)).toBe(503);
    expect(mapPassthroughUpstreamStatus(403)).toBe(503);
    expect(mapPassthroughUpstreamStatus(500)).toBe(503);
  });
});

describe("Cerebras prompt cache key", () => {
  test("accepts canonical and compatibility forms with canonical precedence", () => {
    expect(
      resolvePromptCacheKey({ prompt_cache_key: "v5:abc" } as never),
    ).toEqual({ key: "v5:abc" });
    expect(
      resolvePromptCacheKey({ promptCacheKey: "legacy" } as never),
    ).toEqual({ key: "legacy" });
    expect(
      resolvePromptCacheKey({
        prompt_cache_key: "canonical",
        promptCacheKey: "legacy",
      } as never),
    ).toEqual({ key: "canonical" });
  });
  test("rejects empty, oversized, and non-string values", () => {
    for (const value of ["", "x".repeat(1025), 42, null])
      expect(
        resolvePromptCacheKey({ prompt_cache_key: value } as never),
      ).toHaveProperty("error");
  });
  test("merges provider options without overwriting existing providers", () => {
    const merged = mergePromptCacheProviderOptions(
      {
        providerOptions: {
          anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
        },
      } as never,
      "v5:abc",
    );
    expect(merged.providerOptions?.anthropic).toBeDefined();
    expect(merged.providerOptions?.openai).toMatchObject({
      promptCacheKey: "v5:abc",
    });
    expect(merged.providerOptions?.cerebras).toMatchObject({
      prompt_cache_key: "v5:abc",
      promptCacheKey: "v5:abc",
    });
    expect(merged.providerOptions?.eliza).toMatchObject({
      promptCacheKey: "v5:abc",
    });
  });
  test("redacts an echoed cache key without changing unrelated errors", () => {
    const { redactPromptCacheKey } = __nativeToolingTestHooks;
    expect(
      redactPromptCacheKey(
        "provider rejected opaque-cache-key in request",
        "opaque-cache-key",
      ),
    ).toBe("provider rejected [REDACTED_PROMPT_CACHE_KEY] in request");
    expect(redactPromptCacheKey("queue is saturated", "opaque-cache-key")).toBe(
      "queue is saturated",
    );
  });
});
