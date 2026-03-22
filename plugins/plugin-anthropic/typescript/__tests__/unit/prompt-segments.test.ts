/**
 * Unit tests for promptSegments (cache hints) in Anthropic text model.
 * When promptSegments is provided, request uses messages with cache_control on stable segments.
 */

import { describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn().mockResolvedValue({ text: "ok", usage: undefined });

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));

vi.mock("../../providers", () => ({
  createAnthropicClientWithTopPSupport: () => () => "claude-3-5-sonnet-20241022",
}));

const createMockRuntime = () =>
  ({
    character: { name: "Test", system: "You are helpful." },
    getSetting: vi.fn().mockReturnValue(undefined),
  }) as unknown as import("@elizaos/core").IAgentRuntime;

describe("Anthropic promptSegments", () => {
  it("should use messages with cache_control on stable segments when promptSegments provided", async () => {
    const { handleTextLarge } = await import("../../models/text");
    const runtime = createMockRuntime();
    const params: import("@elizaos/core").GenerateTextParams = {
      prompt: "unstable stable part",
      promptSegments: [
        { content: "unstable ", stable: false },
        { content: "stable part", stable: true },
      ],
    };

    await handleTextLarge(runtime, params);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.messages).toBeDefined();
    expect(call.prompt).toBeUndefined();
    const messages = call.messages as Array<{ role: string; content: Array<{ type: string; text: string; cache_control?: unknown }> }>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
    const content = messages[0]?.content ?? [];
    expect(content.length).toBe(2);
    expect(content[0]?.text).toBe("unstable ");
    expect(content[0]?.cache_control).toBeUndefined();
    expect(content[1]?.text).toBe("stable part");
    expect(content[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  it("should use prompt when promptSegments absent", async () => {
    generateTextMock.mockClear();
    const { handleTextLarge } = await import("../../models/text");
    const runtime = createMockRuntime();
    const params: import("@elizaos/core").GenerateTextParams = {
      prompt: "single prompt",
    };

    await handleTextLarge(runtime, params);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.prompt).toBe("single prompt");
    expect(call.messages).toBeUndefined();
  });
});
