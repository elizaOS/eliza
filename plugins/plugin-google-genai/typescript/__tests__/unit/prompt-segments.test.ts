/**
 * Unit tests for promptSegments (prefix cache hints) in Google GenAI text model.
 * When promptSegments is provided, contents sent to API is stable segments first, then unstable.
 */

import { describe, expect, it, vi } from "vitest";

const generateContentMock = vi.fn().mockResolvedValue({ text: "ok" });

vi.mock("@elizaos/core", () => ({
  logger: {
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  ModelType: {
    TEXT_SMALL: "TEXT_SMALL",
    TEXT_LARGE: "TEXT_LARGE",
    TEXT_EMBEDDING: "TEXT_EMBEDDING",
    IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
    OBJECT_SMALL: "OBJECT_SMALL",
    OBJECT_LARGE: "OBJECT_LARGE",
  },
  EventType: { MODEL_USED: "MODEL_USED" },
}));

vi.mock("../../utils/config", () => ({
  createGoogleGenAI: () => ({
    models: {
      generateContent: generateContentMock,
    },
  }),
  getSmallModel: () => "gemini-2.0-flash-001",
  getLargeModel: () => "gemini-2.0-flash-001",
  getSafetySettings: () => [],
}));

vi.mock("../../utils/events", () => ({
  emitModelUsageEvent: vi.fn(),
}));

vi.mock("../../utils/tokenization", () => ({
  countTokens: vi.fn().mockResolvedValue(10),
}));

const createMockRuntime = () =>
  ({
    character: { name: "Test", system: "You are helpful." },
    getSetting: vi.fn().mockReturnValue(undefined),
  }) as unknown as import("@elizaos/core").IAgentRuntime;

describe("Google GenAI promptSegments", () => {
  it("should send contents with stable segments first when promptSegments provided", async () => {
    const { handleTextSmall } = await import("../../models/text");
    const runtime = createMockRuntime();
    const params: import("@elizaos/core").GenerateTextParams = {
      prompt: "variablePartFormatPartEndPart",
      promptSegments: [
        { content: "variablePart", stable: false },
        { content: "FormatPart", stable: true },
        { content: "EndPart", stable: false },
      ],
    };

    await handleTextSmall(runtime, params);

    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const call = generateContentMock.mock.calls[0]?.[0] as { contents?: string };
    const contentsSent = call.contents;
    const stableFirst = "FormatPart" + "variablePart" + "EndPart";
    expect(contentsSent).toBe(stableFirst);
    expect(contentsSent).not.toBe(params.prompt);
  });

  it("should use params.prompt when promptSegments absent", async () => {
    generateContentMock.mockClear();
    const { handleTextSmall } = await import("../../models/text");
    const runtime = createMockRuntime();
    const params: import("@elizaos/core").GenerateTextParams = {
      prompt: "single prompt",
    };

    await handleTextSmall(runtime, params);

    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const call = generateContentMock.mock.calls[0]?.[0] as { contents?: string };
    expect(call.contents).toBe("single prompt");
  });
});
