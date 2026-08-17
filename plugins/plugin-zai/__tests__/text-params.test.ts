/** Unit tests for text-param resolution (model selection, max-token caps, thinking body) driving mocked `ai.generateText` and the z.ai client — no live model. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateTextMock = vi.fn(async () => ({ text: "ok", usage: undefined }));
const streamTextMock = vi.fn((_options?: { onError?: (event: { error: unknown }) => void }) => ({
  textStream: (async function* () {
    yield "go";
    yield "go";
    yield " stop";
  })(),
  text: Promise.resolve("gogo stop"),
  usage: Promise.resolve(undefined),
  finishReason: Promise.resolve("stop"),
}));
const createOpenAICompatibleMock = vi.fn(() => (modelName: string) => ({ modelName }));

vi.mock("ai", () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

vi.mock("@elizaos/core", () => ({
  ElizaError: class extends Error {
    readonly code: string;
    readonly context?: Record<string, unknown>;
    constructor(
      message: string,
      options: { code: string; context?: Record<string, unknown>; cause?: unknown }
    ) {
      super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
      this.code = options.code;
      this.context = options.context;
    }
  },
  logger: { log: vi.fn() },
  ModelType: { TEXT_SMALL: "TEXT_SMALL", TEXT_LARGE: "TEXT_LARGE" },
}));

describe("z.ai text parameter resolution", () => {
  beforeEach(() => {
    generateTextMock.mockClear();
    streamTextMock.mockClear();
    createOpenAICompatibleMock.mockClear();
  });

  it("advertises both GLM text handlers as streamable", async () => {
    const { zaiPlugin } = await import("../index");

    expect(zaiPlugin.modelMetadata).toEqual({
      TEXT_SMALL: { streamable: true },
      TEXT_LARGE: { streamable: true },
    });
  });

  it("streams repeated GLM deltas without content-based coalescing", async () => {
    const runtime = {
      character: {},
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        return undefined;
      },
    };
    const chunks: string[] = [];
    const { handleTextLarge } = await import("../models/text");

    await expect(
      handleTextLarge(runtime as never, {
        prompt: "repeat a word",
        stream: true,
        onStreamChunk: async (chunk: string) => {
          chunks.push(chunk);
        },
      })
    ).resolves.toBe("gogo stop");

    expect(chunks).toEqual(["go", "go", " stop"]);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("passes cancellation to the transport and stops after an aborted chunk", async () => {
    const runtime = {
      character: {},
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        return undefined;
      },
    };
    const controller = new AbortController();
    const chunks: string[] = [];
    const { handleTextSmall } = await import("../models/text");

    await expect(
      handleTextSmall(runtime as never, {
        prompt: "hello",
        stream: true,
        signal: controller.signal,
        onStreamChunk: (chunk: string) => {
          chunks.push(chunk);
          controller.abort(new DOMException("stopped", "AbortError"));
        },
      })
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: controller.signal })
    );
    expect(chunks).toEqual(["go"]);
  });

  it("surfaces a provider stream failure instead of fabricating empty text", async () => {
    const providerError = new Error("z.ai stream failed");
    streamTextMock.mockImplementationOnce((options) => {
      options?.onError?.({ error: providerError });
      return {
        textStream: (async function* () {})(),
        text: Promise.reject(providerError),
        usage: Promise.resolve(undefined),
        finishReason: Promise.resolve(undefined),
      };
    });
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
        stream: true,
        onStreamChunk: () => undefined,
      })
    ).rejects.toBe(providerError);
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

  it("honors a per-call model override before z.ai slot defaults", async () => {
    const runtime = {
      character: {},
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        if (key === "ZAI_LARGE_MODEL") return "glm-default-large";
        return undefined;
      },
    };

    const { handleTextLarge } = await import("../models/text");

    await expect(
      handleTextLarge(runtime as never, {
        prompt: "hello",
        model: " glm-workflow ",
      })
    ).resolves.toBe("ok");

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelName: "glm-workflow" },
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

  it("does not overwrite a thinking field already present in the request body", async () => {
    const fetchMock = vi.fn(async () => new Response("ok")) as typeof fetch;
    const runtime = {
      character: {},
      fetch: fetchMock,
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        if (key === "ZAI_THINKING_TYPE") return "enabled";
        return undefined;
      },
    };

    const { handleTextSmall } = await import("../models/text");

    await expect(handleTextSmall(runtime as never, { prompt: "hello" })).resolves.toBe("ok");

    const fetcher = createOpenAICompatibleMock.mock.calls[0]?.[0]?.fetch as typeof fetch;
    await fetcher("https://api.z.ai/api/paas/v4/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-4.5-air", thinking: { type: "disabled" } }),
    });

    const forwardedInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(forwardedInit.body))).toEqual({
      model: "glm-4.5-air",
      thinking: { type: "disabled" },
    });
  });

  it("passes non-JSON request bodies through unchanged when thinking mode is enabled", async () => {
    const fetchMock = vi.fn(async () => new Response("ok")) as typeof fetch;
    const runtime = {
      character: {},
      fetch: fetchMock,
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        if (key === "ZAI_THINKING_TYPE") return "enabled";
        return undefined;
      },
    };

    const { handleTextSmall } = await import("../models/text");

    await expect(handleTextSmall(runtime as never, { prompt: "hello" })).resolves.toBe("ok");

    const fetcher = createOpenAICompatibleMock.mock.calls[0]?.[0]?.fetch as typeof fetch;
    await fetcher("https://api.z.ai/api/paas/v4/chat/completions", {
      method: "POST",
      body: "not-json",
    });

    const forwardedInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(forwardedInit.body).toBe("not-json");
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
