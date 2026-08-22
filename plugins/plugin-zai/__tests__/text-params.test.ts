/** Unit tests for text-param resolution (model selection, max-token caps, thinking body) driving mocked `ai.generateText` and the z.ai client — no live model. */
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

  it("rejects multiple stop sequences instead of silently dropping model semantics", async () => {
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
    ).rejects.toMatchObject({
      code: "ZAI_STOP_SEQUENCE_LIMIT_EXCEEDED",
      context: { maximum: 1, received: 2 },
    });

    expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("preserves the one stop sequence supported by z.ai", async () => {
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
        stopSequences: ["</one>"],
      })
    ).resolves.toBe("ok");

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ stopSequences: ["</one>"] })
    );
  });

  it("handles valid providerOptions and rejects cyclic providerOptions with ZAI_PROVIDER_OPTIONS_UNBOUNDED", async () => {
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
        providerOptions: { agentName: "test-agent", extra: { foo: "bar" } },
      })
    ).resolves.toBe("ok");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    await expect(
      handleTextSmall(runtime as never, {
        prompt: "hello",
        providerOptions: cyclic as never,
      })
    ).rejects.toMatchObject({
      code: "ZAI_PROVIDER_OPTIONS_UNBOUNDED",
    });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["small", "handleTextSmall"],
    ["large", "handleTextLarge"],
  ] as const)(
    "rejects malformed present providerOptions before %s provider dispatch",
    async (_size, handlerName) => {
      const runtime = {
        character: {},
        getSetting(key: string) {
          if (key === "ZAI_API_KEY") return "test-key";
          return undefined;
        },
      };
      const handlers = await import("../models/text");
      const handler = handlers[handlerName];

      for (const providerOptions of [
        { agentName: "keep", bad: 1n },
        new Date(0),
        { nested: new Map([["enabled", true]]) },
      ]) {
        await expect(
          handler(runtime as never, {
            prompt: "hello",
            providerOptions: providerOptions as never,
          })
        ).rejects.toMatchObject({ code: "ZAI_PROVIDER_OPTIONS_UNBOUNDED" });
      }

      expect(createOpenAICompatibleMock).not.toHaveBeenCalled();
      expect(generateTextMock).not.toHaveBeenCalled();
    }
  );
});
