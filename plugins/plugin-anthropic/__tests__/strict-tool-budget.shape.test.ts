/**
 * Anthropic strict-tool grammar budget (#16499): the server hard-400s any
 * request whose STRICT tool surface exceeds 20 strict tools or 24 optional
 * parameters counted recursively across strict schemas. The enforcer
 * downgrades an over-budget surface to non-strict for that request (looser
 * tool-calling instead of a failed turn) and passes under-budget surfaces
 * through untouched — covering BOTH strict-carrying shapes (flat definitions
 * and OpenAI-style `function` wrappers).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enforceAnthropicStrictToolBudget } from "../models/text";

type LooseToolSet = Record<string, unknown>;

function flatStrictTool(optionalParams: number, requiredParams = 0) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (let i = 0; i < optionalParams; i++) {
    properties[`opt_${i}`] = { type: "string" };
  }
  for (let i = 0; i < requiredParams; i++) {
    properties[`req_${i}`] = { type: "string" };
    required.push(`req_${i}`);
  }
  return {
    description: "synthetic",
    strict: true,
    parameters: { type: "object", properties, required },
  };
}

describe("enforceAnthropicStrictToolBudget (#16499)", () => {
  it("passes an under-budget strict surface through untouched (same reference)", () => {
    const tools = {
      a: flatStrictTool(10),
      b: flatStrictTool(10),
    } as LooseToolSet;
    const out = enforceAnthropicStrictToolBudget(
      tools as Parameters<typeof enforceAnthropicStrictToolBudget>[0]
    );
    expect(out).toBe(tools);
  });

  it("downgrades when optional params exceed 24 — the Appendix-A shape (25 optional, 0 required)", () => {
    const tools = { demo_tool: flatStrictTool(25) } as LooseToolSet;
    const out = enforceAnthropicStrictToolBudget(
      tools as Parameters<typeof enforceAnthropicStrictToolBudget>[0]
    ) as LooseToolSet;
    expect((out.demo_tool as Record<string, unknown>).strict).toBeUndefined();
    // The schema itself is preserved — only strictness is dropped.
    expect((out.demo_tool as { parameters: { properties: object } }).parameters.properties).toEqual(
      (tools.demo_tool as { parameters: { properties: object } }).parameters.properties
    );
  });

  it("required params do NOT count toward the optional budget", () => {
    const tools = { t: flatStrictTool(24, 40) } as LooseToolSet;
    const out = enforceAnthropicStrictToolBudget(
      tools as Parameters<typeof enforceAnthropicStrictToolBudget>[0]
    );
    expect(out).toBe(tools);
  });

  it("counts nested optionals through objects and array items", () => {
    // 1 top-level optional + 24 optionals nested inside an array item object
    // (the REPLY `questions` shape from the issue) → 25 total → downgrade.
    const nestedProperties: Record<string, unknown> = {};
    for (let i = 0; i < 24; i++) nestedProperties[`n_${i}`] = { type: "string" };
    const tools = {
      REPLY: {
        strict: true,
        parameters: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: nestedProperties,
                required: [],
              },
            },
          },
          required: [],
        },
      },
    } as LooseToolSet;
    const out = enforceAnthropicStrictToolBudget(
      tools as Parameters<typeof enforceAnthropicStrictToolBudget>[0]
    ) as LooseToolSet;
    expect((out.REPLY as Record<string, unknown>).strict).toBeUndefined();
  });

  it("downgrades when more than 20 strict tools are present, even with tiny schemas", () => {
    const tools: LooseToolSet = {};
    for (let i = 0; i < 21; i++) tools[`tool_${i}`] = flatStrictTool(1);
    const out = enforceAnthropicStrictToolBudget(
      tools as Parameters<typeof enforceAnthropicStrictToolBudget>[0]
    ) as LooseToolSet;
    for (let i = 0; i < 21; i++) {
      expect((out[`tool_${i}`] as Record<string, unknown>).strict).toBeUndefined();
    }
  });

  it("strips the OpenAI-style wrapper's nested strict flag too", () => {
    const tools = {
      wrapped: {
        type: "function",
        function: {
          name: "wrapped",
          strict: true,
          parameters: flatStrictTool(30).parameters,
        },
      },
    } as LooseToolSet;
    const out = enforceAnthropicStrictToolBudget(
      tools as Parameters<typeof enforceAnthropicStrictToolBudget>[0]
    ) as LooseToolSet;
    const fn = (out.wrapped as { function: Record<string, unknown> }).function;
    expect(fn.strict).toBeUndefined();
    expect(fn.name).toBe("wrapped");
  });

  it("ignores non-strict tools entirely — no strict entries, no downgrade", () => {
    const nonStrict = {
      big: {
        description: "fat but not strict",
        parameters: flatStrictTool(60).parameters,
      },
    } as LooseToolSet;
    const out = enforceAnthropicStrictToolBudget(
      nonStrict as Parameters<typeof enforceAnthropicStrictToolBudget>[0]
    );
    expect(out).toBe(nonStrict);
  });

  it("returns undefined tools untouched", () => {
    expect(enforceAnthropicStrictToolBudget(undefined)).toBeUndefined();
  });
});

// ── Pipeline-level: the budget is enforced at the real provider seam ─────────
// Mirrors effort-thinking.shape's harness: mocked AI SDK, REAL handleTextLarge.
function createRuntime(settings: Record<string, string>) {
  return {
    character: { name: "Claude Agent", system: "system prompt" },
    emitEvent: vi.fn(),
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

function mockAiSdk() {
  const generateText = vi.fn(async () => ({
    text: "ok",
    finishReason: "stop",
    usage: { inputTokens: 5, outputTokens: 2 },
  }));
  vi.doMock("ai", () => ({
    generateText,
    streamText: vi.fn(),
    jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
  }));
  vi.doMock("../providers/anthropic", () => ({
    createAnthropicClientWithTopPSupport: () => (modelName: string) => ({
      modelId: modelName,
    }),
  }));
  return generateText;
}

function sdkStyleStrictTools(count: number): Record<string, unknown> {
  // SDK-style entries (no top-level .name) ride readToolSet's passthrough
  // branch, which preserves `strict` — the strict-carrying path the budget
  // must defend.
  const tools: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    tools[`tool_${i}`] = {
      description: `synthetic ${i}`,
      strict: true,
      inputSchema: {
        jsonSchema: {
          type: "object",
          properties: { one: { type: "string" } },
          required: [],
        },
      },
    };
  }
  return tools;
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers/anthropic");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("ACTION_PLANNER with the issue's surface shape (#16499)", () => {
  it("an over-budget planner tool surface reaches the SDK strict-free and intact", async () => {
    const generateText = mockAiSdk();
    const { handleActionPlanner } = await import("../models/text");
    // Planner tools are FLAT named definitions with top-level strict:true
    // (core/actions/to-tool.ts). 21 of them + fat optional schemas = both
    // caps exceeded — the exact live-mention failure from the issue.
    const plannerTools = Array.from({ length: 21 }, (_, i) => ({
      name: `ACTION_${i}`,
      description: `action ${i}`,
      type: "function",
      strict: true,
      parameters: {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: [],
      },
    }));
    await handleActionPlanner(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_LARGE_MODEL: "claude-sonnet-4-5",
      }),
      { prompt: "plan", tools: plannerTools } as never
    );
    const call = generateText.mock.calls[0]?.[0] as
      | { tools?: Record<string, Record<string, unknown>> }
      | undefined;
    if (!call?.tools) throw new Error("generateText received no tools");
    // Every action arrives as a named tool, none of them strict — the surface
    // that used to 400 now compiles without the grammar caps.
    expect(Object.keys(call.tools)).toHaveLength(21);
    expect(call.tools.ACTION_0?.strict).toBeUndefined();
    expect(call.tools.ACTION_20).toBeDefined();
  }, 60_000);
});

describe("tool-free calls are untouched by the budget (#16499)", () => {
  it("handleTextSmall with no tools calls the SDK without a tools field", async () => {
    const generateText = mockAiSdk();
    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_SMALL_MODEL: "claude-haiku-4-5",
      }),
      { prompt: "hi" } as never
    );
    const call = generateText.mock.calls[0]?.[0] as { tools?: unknown } | undefined;
    if (!call) throw new Error("generateText was not called");
    expect(call.tools).toBeUndefined();
  }, 60_000);
});

describe("Stage-1 HANDLE_RESPONSE with an over-budget schema (#16499)", () => {
  it("a single fat strict tool (the 66-optional-param HANDLE_RESPONSE shape) is sent non-strict", async () => {
    const generateText = mockAiSdk();
    const { handleResponseHandler } = await import("../models/text");
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 66; i++) properties[`field_${i}`] = { type: "string" };
    await handleResponseHandler(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_LARGE_MODEL: "claude-sonnet-4-5",
      }),
      {
        prompt: "handle",
        tools: {
          HANDLE_RESPONSE: {
            description: "stage 1",
            strict: true,
            inputSchema: {
              jsonSchema: { type: "object", properties, required: [] },
            },
          },
        },
        toolChoice: { type: "tool", name: "HANDLE_RESPONSE" },
      } as never
    );
    const call = generateText.mock.calls[0]?.[0] as
      | {
          tools?: Record<string, Record<string, unknown>>;
          toolChoice?: unknown;
        }
      | undefined;
    if (!call?.tools) throw new Error("generateText received no tools");
    expect(call.tools.HANDLE_RESPONSE?.strict).toBeUndefined();
    // The forced tool choice survives the downgrade.
    expect(call.toolChoice).toEqual({
      type: "tool",
      toolName: "HANDLE_RESPONSE",
    });
  }, 60_000);
});

describe("strict-tool budget at the handleTextLarge seam (#16499)", () => {
  it("an over-budget strict surface reaches the SDK with strict stripped (no 400)", async () => {
    const generateText = mockAiSdk();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_LARGE_MODEL: "claude-sonnet-4-5",
      }),
      {
        prompt: "hi",
        tools: sdkStyleStrictTools(21),
      } as never
    );
    const call = generateText.mock.calls[0]?.[0] as
      | { tools?: Record<string, Record<string, unknown>> }
      | undefined;
    if (!call?.tools) throw new Error("generateText received no tools");
    expect(Object.keys(call.tools)).toHaveLength(21);
    for (const entry of Object.values(call.tools)) {
      expect(entry.strict).toBeUndefined();
    }
  }, 60_000);

  it("an under-budget strict surface keeps its strict flags", async () => {
    const generateText = mockAiSdk();
    const { handleTextLarge } = await import("../models/text");
    await handleTextLarge(
      createRuntime({
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_LARGE_MODEL: "claude-sonnet-4-5",
      }),
      {
        prompt: "hi",
        tools: sdkStyleStrictTools(3),
      } as never
    );
    const call = generateText.mock.calls[0]?.[0] as
      | { tools?: Record<string, Record<string, unknown>> }
      | undefined;
    if (!call?.tools) throw new Error("generateText received no tools");
    for (const entry of Object.values(call.tools)) {
      expect(entry.strict).toBe(true);
    }
  }, 60_000);
});
