import { beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn(async () => ({ text: "ok", usage: undefined }));
const createAnthropicMock = vi.fn(() => (modelName: string) => ({ modelName }));

vi.mock("ai", () => ({
  generateText: generateTextMock,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock,
}));

vi.mock("@elizaos/core", () => ({
  logger: { log: vi.fn() },
  ModelType: { TEXT_SMALL: "TEXT_SMALL", TEXT_LARGE: "TEXT_LARGE" },
}));

describe("z.ai text parameter resolution", () => {
  beforeEach(() => {
    generateTextMock.mockClear();
    createAnthropicMock.mockClear();
  });

  it("does not treat undefined temperature as explicit when topP is set", async () => {
    const runtime = {
      character: {},
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        return undefined;
      },
    };

    const { handleTextSmall } = await import("../models/text");

    await expect(
      handleTextSmall(runtime as never, {
        prompt: "hello",
        topP: 0.8,
        temperature: undefined,
      })
    ).resolves.toBe("ok");

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        topP: 0.8,
        temperature: undefined,
      })
    );
  });

  it("passes configured CoT budget through Anthropic provider options", async () => {
    const runtime = {
      character: {},
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        if (key === "ZAI_COT_BUDGET_SMALL") return "2048";
        return undefined;
      },
    };

    const { handleTextSmall } = await import("../models/text");

    await expect(handleTextSmall(runtime as never, { prompt: "hello" })).resolves.toBe("ok");

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: {
          anthropic: {
            thinking: { type: "enabled", budgetTokens: 2048 },
          },
        },
      })
    );
  });

  it("still rejects non-null temperature and topP together", async () => {
    const runtime = {
      character: {},
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        return undefined;
      },
    };

    const { handleTextSmall } = await import("../models/text");

    await expect(
      handleTextSmall(runtime as never, {
        prompt: "hello",
        topP: 0.8,
        temperature: 0.2,
      })
    ).rejects.toThrow("Cannot use both temperature and topP");
  });
});
