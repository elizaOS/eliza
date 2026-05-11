import { beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn(async () => ({ text: "ok", usage: undefined }));
const createOpenAICompatibleMock = vi.fn(() => (modelName: string) => ({ modelName }));

vi.mock("ai", () => ({
  generateText: generateTextMock,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

vi.mock("@elizaos/core", () => ({
  logger: { log: vi.fn() },
  ModelType: { TEXT_SMALL: "TEXT_SMALL", TEXT_LARGE: "TEXT_LARGE" },
}));

describe("z.ai text parameter resolution", () => {
  beforeEach(() => {
    generateTextMock.mockClear();
    createOpenAICompatibleMock.mockClear();
  });

  it("passes topP and temperature to z.ai's OpenAI-compatible API", async () => {
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
    ).resolves.toBe("ok");

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        topP: 0.8,
        temperature: 0.2,
      })
    );
  });

  it("uses deprecated CoT budget settings to enable z.ai thinking mode", async () => {
    const fetchMock = vi.fn(async () => new Response("ok")) as typeof fetch;
    const runtime = {
      character: {},
      fetch: fetchMock,
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        if (key === "ZAI_COT_BUDGET_SMALL") return "2048";
        return undefined;
      },
    };

    const { handleTextSmall } = await import("../models/text");

    await expect(handleTextSmall(runtime as never, { prompt: "hello" })).resolves.toBe("ok");

    const fetcher = createOpenAICompatibleMock.mock.calls[0]?.[0]?.fetch as typeof fetch;
    await fetcher("https://api.z.ai/api/paas/v4/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-4.5-air", messages: [] }),
    });

    const forwardedInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(forwardedInit.body))).toEqual({
      model: "glm-4.5-air",
      messages: [],
      thinking: { type: "enabled" },
    });
  });

  it("honors explicit z.ai thinking mode override", async () => {
    const fetchMock = vi.fn(async () => new Response("ok")) as typeof fetch;
    const runtime = {
      character: {},
      fetch: fetchMock,
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        if (key === "ZAI_THINKING_TYPE") return "disabled";
        return undefined;
      },
    };

    const { handleTextSmall } = await import("../models/text");

    await expect(handleTextSmall(runtime as never, { prompt: "hello" })).resolves.toBe("ok");

    const fetcher = createOpenAICompatibleMock.mock.calls[0]?.[0]?.fetch as typeof fetch;
    await fetcher("https://api.z.ai/api/paas/v4/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-4.5-air", messages: [] }),
    });

    const forwardedInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(forwardedInit.body))).toEqual({
      model: "glm-4.5-air",
      messages: [],
      thinking: { type: "disabled" },
    });
  });

  it("sends at most one stop sequence because z.ai supports one stop word", async () => {
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
        stopSequences: ["</one>", "</two>"],
      })
    ).resolves.toBe("ok");

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        stopSequences: ["</one>"],
      })
    );
  });
});
