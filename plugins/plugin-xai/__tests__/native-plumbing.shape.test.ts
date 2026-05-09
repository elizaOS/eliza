import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createRuntime() {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        XAI_API_KEY: "test-key",
        XAI_SMALL_MODEL: "grok-test-small",
      };
      return settings[key] ?? null;
    }),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

beforeEach(() => {
  vi.resetModules();
});

describe("xAI native text plumbing", () => {
  it("forwards tools and returns native shape with toolCalls when caller passes tools", { timeout: 15000 }, async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "grok-test-small",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"q":"x"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { handleTextSmall } = await import("../models/grok");
    const tools = { lookup: { description: "Lookup", inputSchema: { type: "object" } } };
    const result = (await handleTextSmall(createRuntime(), {
      prompt: "use the tool",
      tools,
    } as never)) as unknown as Record<string, unknown>;

    const requestBody = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(Array.isArray(requestBody.tools)).toBe(true);
    expect((requestBody.tools as Array<Record<string, unknown>>)[0]?.type).toBe("function");
    expect(result).toMatchObject({
      text: "",
      finishReason: "tool_calls",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
    expect((result.toolCalls as unknown[]).length).toBe(1);
    expect((result.toolCalls as Array<Record<string, unknown>>)[0]).toMatchObject({
      toolCallId: "call_1",
      toolName: "lookup",
      input: { q: "x" },
    });
  });

  it("returns plain text string when no tools/messages/responseSchema/toolChoice provided", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "grok-test-small",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { handleTextSmall } = await import("../models/grok");
    const result = await handleTextSmall(createRuntime(), { prompt: "hi" });
    expect(result).toBe("hello");
  });
});
