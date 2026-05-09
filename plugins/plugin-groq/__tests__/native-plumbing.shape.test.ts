import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime() {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        GROQ_API_KEY: "test-key",
        GROQ_SMALL_MODEL: "groq-small",
      };
      return settings[key] ?? null;
    }),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("@ai-sdk/groq");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Groq native text plumbing", () => {
  it("forwards tools and returns native shape with toolCalls when caller passes tools", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
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
    const tools = { lookup: { description: "Lookup", inputSchema: { type: "object" } } };
    const result = (await handler(createRuntime(), {
      prompt: "use the tool",
      tools,
    })) as Record<string, unknown>;

    const firstCall = generateText.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    const call = firstCall[0];
    expect(call.tools).toBe(tools);
    expect(result).toMatchObject({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
  });

  it("returns plain text string when no tools/messages/responseSchema/toolChoice provided", async () => {
    const generateText = vi.fn(async () => ({
      text: "hello",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
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
    const result = await handler(createRuntime(), { prompt: "hi" });
    expect(result).toBe("hello");
  });
});
