/**
 * Unit tests for promptSegments (prefix cache hints) in OpenAI text model.
 * When promptSegments is provided, prompt sent to API is stable segments first, then unstable.
 */

import { describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn().mockResolvedValue({ text: "ok", usage: undefined });

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  streamText: vi.fn(),
}));

const mockChat = vi.fn().mockReturnValue("gpt-4o");
vi.mock("../providers", () => ({
  createOpenAIClient: () => ({
    chat: (...args: unknown[]) => mockChat(...args),
  }),
}));

const createMockRuntime = () =>
  ({
    character: { name: "Test", system: "You are helpful." },
    getSetting: vi.fn().mockReturnValue(undefined),
  }) as unknown as import("@elizaos/core").IAgentRuntime;

describe("OpenAI promptSegments", () => {
  it("should send prompt with stable segments first when promptSegments provided", async () => {
    const { handleTextLarge } = await import("../models/text");
    const runtime = createMockRuntime();
    const params: import("@elizaos/core").GenerateTextParams = {
      prompt: "variablePartFormatPartEndPart",
      promptSegments: [
        { content: "variablePart", stable: false },
        { content: "FormatPart", stable: true },
        { content: "EndPart", stable: false },
      ],
    };

    await handleTextLarge(runtime, params);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    const promptSent = call.prompt as string;
    const stableFirst = "FormatPart" + "variablePart" + "EndPart";
    expect(promptSent).toBe(stableFirst);
    expect(promptSent).not.toBe(params.prompt);
  });

  it("should use params.prompt when promptSegments absent", async () => {
    generateTextMock.mockClear();
    const { handleTextLarge } = await import("../models/text");
    const runtime = createMockRuntime();
    const params: import("@elizaos/core").GenerateTextParams = {
      prompt: "single prompt",
    };

    await handleTextLarge(runtime, params);

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const call = generateTextMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.prompt).toBe("single prompt");
  });
});
