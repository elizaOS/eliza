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

describe("NEAR AI text parameter resolution", () => {
  beforeEach(() => {
    generateTextMock.mockClear();
    createOpenAICompatibleMock.mockClear();
  });

  it("passes topP and temperature to NEAR AI's OpenAI-compatible API", async () => {
    const runtime = {
      character: {},
      getSetting(key: string) {
        if (key === "NEARAI_API_KEY") return "test-key";
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

  it("normalizes OpenAI request fields that NEAR AI does not accept", async () => {
    const fetchMock = vi.fn(async () => new Response("ok")) as typeof fetch;
    const runtime = {
      character: {},
      fetch: fetchMock,
      getSetting(key: string) {
        if (key === "NEARAI_API_KEY") return "test-key";
        return undefined;
      },
    };

    const { handleTextSmall } = await import("../models/text");

    await expect(handleTextSmall(runtime as never, { prompt: "hello" })).resolves.toBe("ok");

    const fetcher = createOpenAICompatibleMock.mock.calls[0]?.[0]?.fetch as typeof fetch;
    await fetcher("https://cloud-api.near.ai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "Qwen/Qwen3.6-35B-A3B-FP8",
        messages: [{ role: "developer", content: "follow policy" }],
        max_completion_tokens: 1024,
        store: true,
        reasoning_effort: "medium",
        strict: true,
      }),
    });

    const forwardedInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(forwardedInit.body))).toEqual({
      model: "Qwen/Qwen3.6-35B-A3B-FP8",
      messages: [{ role: "system", content: "follow policy" }],
      max_tokens: 1024,
    });
  });

  it("preserves stop sequences for the OpenAI-compatible API", async () => {
    const runtime = {
      character: {},
      getSetting(key: string) {
        if (key === "NEARAI_API_KEY") return "test-key";
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
        stopSequences: ["</one>", "</two>"],
      })
    );
  });
});
