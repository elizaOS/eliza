import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime() {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_SMALL_MODEL: "openrouter-small",
      };
      return settings[key] ?? null;
    }),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("OpenRouter native text plumbing", () => {
  it("passes native messages and tools through and returns text result shape", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({
        chat: (modelName: string) => ({ modelName }),
      }),
    }));

    const { handleTextSmall } = await import("../models/text");
    const messages = [{ role: "user", content: "use the tool" }];
    const tools = { lookup: { description: "Lookup", inputSchema: { type: "object" } } };
    const result = (await handleTextSmall(createRuntime(), {
      prompt: "legacy prompt",
      messages,
      tools,
    } as never)) as unknown as Record<string, unknown>;

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.messages).toBe(messages);
    expect(call).not.toHaveProperty("prompt");
    expect(call.tools).toBe(tools);
    expect(result).toMatchObject({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
  });
});
