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

import { __nativeToolingTestHooks } from "../v1/chat/completions/route";

const {
  mapToolChoice,
  convertTools,
  computeEffectiveMaxTokens,
  validateCerebrasReasoningEffort,
  buildReasoningEffortProviderOptions,
  toOpenAiFinishReason,
} = __nativeToolingTestHooks;

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
 * computeEffectiveMaxTokens guarantees a response-token budget so reasoning
 * models do not truncate mid-chain-of-thought and return empty (but billed)
 * completions. Before the fix, only Anthropic CoT (cotBudget != null) got a
 * floor; every other reasoning model fell through and returned the raw
 * (often tiny) request max_tokens.
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

  test("reasoning model with tiny max_tokens: floors to MIN_RESPONSE_TOKENS", () => {
    // This is the bug: minimax/m3 at max_tokens=10 spent all 10 on reasoning
    // and returned null content while billing the tokens.
    expect(computeEffectiveMaxTokens(10, null, "minimax/minimax-m3")).toBe(
      MIN_RESPONSE_TOKENS,
    );
    expect(computeEffectiveMaxTokens(16, null, "deepseek/deepseek-r1")).toBe(
      MIN_RESPONSE_TOKENS,
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

  test("active Cerebras reasoning retains the response-token floor", () => {
    expect(
      computeEffectiveMaxTokens(512, null, "gemma-4-31b", undefined, "low"),
    ).toBe(MIN_RESPONSE_TOKENS);
    expect(computeEffectiveMaxTokens(512, null, "zai-glm-4.7")).toBe(
      MIN_RESPONSE_TOKENS,
    );
    expect(
      computeEffectiveMaxTokens(512, null, "gpt-oss-120b", undefined, "low"),
    ).toBe(MIN_RESPONSE_TOKENS);
  });

  test("Anthropic CoT budget: reserves response capacity beyond the thinking budget", () => {
    // cotBudget=8000 -> must be at least 8000 + MIN_RESPONSE_TOKENS regardless of
    // a smaller requested max_tokens.
    expect(
      computeEffectiveMaxTokens(1000, 8000, "anthropic/claude-opus-4.8"),
    ).toBe(8000 + MIN_RESPONSE_TOKENS);
  });

  test("Anthropic CoT budget: honors a larger requested max_tokens", () => {
    expect(
      computeEffectiveMaxTokens(20000, 8000, "anthropic/claude-opus-4.8"),
    ).toBe(20000);
  });

  test("catalog reasoning signal: floors even when the id has no reasoning pattern", () => {
    // glm-5.1 / kimi-k2.6 / deepseek-v4-pro have no "think"/"reasoning" id but
    // advertise reasoning in supported_parameters. These were the
    // production-reported failures.
    expect(
      computeEffectiveMaxTokens(50, null, "z-ai/glm-5.1", [
        "max_tokens",
        "reasoning",
      ]),
    ).toBe(MIN_RESPONSE_TOKENS);
    expect(
      computeEffectiveMaxTokens(50, null, "deepseek/deepseek-v4-pro", [
        "max_tokens",
        "include_reasoning",
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
