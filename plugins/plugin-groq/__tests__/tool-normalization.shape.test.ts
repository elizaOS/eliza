/**
 * Wire-shape tests for Groq tool plumbing and 429 cooldown parsing.
 *
 * The runtime hands plugins core `ToolDefinition[]` arrays and core
 * `ToolChoice` objects ({ type: "tool", name }); the AI SDK needs a ToolSet
 * keyed by tool name (with `inputSchema`) and { type: "tool", toolName }.
 * Passing the raw shapes through gives Groq function names like "0" with an
 * empty schema. Deterministic harness: the `ai` SDK entry is mocked; no live
 * API.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime() {
  return Object.assign(Object.create(null) as IAgentRuntime, {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        GROQ_API_KEY: "test-key",
        GROQ_SMALL_MODEL: "groq-small",
      };
      return settings[key] ?? null;
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("ai");
  vi.doUnmock("@ai-sdk/groq");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Groq core ToolDefinition[] normalization", () => {
  it("converts core ToolDefinition arrays and core toolChoice to the AI SDK shapes", async () => {
    const generateText = vi.fn(async (_options: Record<string, unknown>) => ({
      text: "",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }));
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, generateText };
    });
    vi.doMock("@ai-sdk/groq", () => ({
      createGroq: () => ({
        languageModel: (modelName: string) => ({ modelName }),
      }),
    }));

    const { groqPlugin } = await import("../index");
    const handler = groqPlugin.models?.TEXT_SMALL as (
      runtime: IAgentRuntime,
      params: unknown
    ) => Promise<unknown>;
    const parameters = {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    };
    await handler(createRuntime(), {
      prompt: "use the tool",
      // Core runtime shape: ordered ToolDefinition[] + { type: "tool", name }.
      tools: [{ name: "lookup", description: "Lookup a thing", parameters }],
      toolChoice: { type: "tool", name: "lookup" },
    });

    const call = generateText.mock.calls[0]?.[0] as {
      tools?: Record<string, { description?: string; inputSchema?: { jsonSchema?: unknown } }>;
      toolChoice?: unknown;
    };
    if (!call) {
      throw new Error("Expected generateText to be called");
    }
    expect(call.tools).not.toHaveProperty("0");
    expect(call.tools?.lookup?.description).toBe("Lookup a thing");
    expect(call.tools?.lookup?.inputSchema?.jsonSchema).toEqual(parameters);
    expect(call.toolChoice).toEqual({ type: "tool", toolName: "lookup" });
  });
});

describe("Groq 429 cooldown parsing (extractRetryDelay)", () => {
  it("parses Go-style compound durations from Groq rate-limit messages", async () => {
    vi.doMock("@ai-sdk/groq", () => ({
      createGroq: () => ({
        languageModel: (modelName: string) => ({ modelName }),
      }),
    }));
    const { extractRetryDelay } = await import("../index");
    expect(extractRetryDelay("Rate limit reached. Please try again in 7m30s.")).toBe(451_000);
    expect(extractRetryDelay("Rate limit reached. Please try again in 2m59.56s.")).toBe(180_560);
    expect(extractRetryDelay("Please try again in 30s.")).toBe(31_000);
    expect(extractRetryDelay("Please try again in 859ms.")).toBe(1_859);
    expect(extractRetryDelay("no hint at all")).toBe(10_000);
  });

  it("waits out a minute-format server cooldown before retrying a 429", async () => {
    const delays: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: TimerHandler,
      delay?: number
    ) => {
      delays.push(delay ?? 0);
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const generateText = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Rate limit reached for model. Please try again in 2m59.56s.")
      )
      .mockResolvedValueOnce({
        text: "after cooldown",
        finishReason: "stop",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      });
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<typeof import("ai")>("ai");
      return { ...actual, generateText };
    });
    vi.doMock("@ai-sdk/groq", () => ({
      createGroq: () => ({
        languageModel: (modelName: string) => ({ modelName }),
      }),
    }));

    const { groqPlugin } = await import("../index");
    const handler = groqPlugin.models?.TEXT_SMALL as (
      runtime: IAgentRuntime,
      params: unknown
    ) => Promise<unknown>;
    await expect(handler(createRuntime(), { prompt: "retry me" })).resolves.toBe("after cooldown");

    // hinted 180 560 ms (2m59.56s + 1s) + first-attempt jitter backoff 500 ms.
    expect(delays[0]).toBe(181_060);
  });
});
