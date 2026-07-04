/**
 * Unit tests for the text handlers with the AI SDK, provider, and core mocked:
 * asserts param pass-through (topP/temperature/stopSequences), the request-body
 * normalisation shim (max_completion_tokens→max_tokens, dropped fields, developer→
 * system role, malformed-JSON passthrough), and MODEL_USED usage emission.
 */
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
  EventType: { MODEL_USED: "MODEL_USED" },
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
        model: "google/gemma-4-31B-it",
        messages: [{ role: "developer", content: "follow policy" }],
        max_completion_tokens: 1024,
        store: true,
        reasoning_effort: "medium",
        strict: true,
      }),
    });

    const forwardedInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(forwardedInit.body))).toEqual({
      model: "google/gemma-4-31B-it",
      messages: [{ role: "system", content: "follow policy" }],
      max_tokens: 1024,
    });
  });

  it("does not overwrite an explicit max_tokens field during request normalization", async () => {
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
        max_completion_tokens: 2048,
        max_tokens: 128,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    const forwardedInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(forwardedInit.body))).toEqual({
      max_tokens: 128,
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("passes malformed JSON request bodies through unchanged", async () => {
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
      body: "{not-json",
    });

    const forwardedInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(forwardedInit.body).toBe("{not-json");
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

  it("emits usage events when the AI SDK returns token usage", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      usage: { inputTokens: 7, outputTokens: 11 },
    });
    const emitEvent = vi.fn();
    const runtime = {
      character: {},
      emitEvent,
      getSetting(key: string) {
        if (key === "NEARAI_API_KEY") return "test-key";
        return undefined;
      },
    };

    const { handleTextLarge } = await import("../models/text");

    await expect(handleTextLarge(runtime as never, { prompt: "hello" })).resolves.toBe("ok");

    expect(emitEvent).toHaveBeenCalledWith("MODEL_USED", {
      runtime,
      source: "nearai",
      type: "TEXT_LARGE",
      tokens: {
        prompt: 7,
        completion: 11,
        total: 18,
      },
    });
  });
});
