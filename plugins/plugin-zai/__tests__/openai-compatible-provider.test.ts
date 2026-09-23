/** Unit tests for `createZaiClient`, verifying the base URL and API key passed into a mocked `@ai-sdk/openai-compatible` factory (no live API). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createOpenAICompatibleMock = vi.fn((config: unknown) => config);

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

const originalEnv = { ...process.env };

describe("z.ai OpenAI-compatible provider", () => {
  beforeEach(() => {
    createOpenAICompatibleMock.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses the general z.ai API endpoint", async () => {
    const { createZaiClient } = await import("../providers/openai-compatible");
    const runtime = {
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        return undefined;
      },
    };

    createZaiClient(runtime as never);

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "zai",
        baseURL: "https://api.z.ai/api/paas/v4",
        apiKey: "test-key",
        includeUsage: true,
      })
    );
  });

  it("uses runtime fetch when provided", async () => {
    const { createZaiClient } = await import("../providers/openai-compatible");
    const fetchMock = vi.fn(async () => new Response("ok")) as typeof fetch;
    const runtime = {
      fetch: fetchMock,
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        return undefined;
      },
    };

    createZaiClient(runtime as never);

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: fetchMock })
    );
  });

  it("lets an explicit fetch override runtime fetch", async () => {
    const { createZaiClient } = await import("../providers/openai-compatible");
    const runtimeFetch = vi.fn(async () => new Response("runtime")) as typeof fetch;
    const explicitFetch = vi.fn(async () => new Response("explicit")) as typeof fetch;
    const runtime = {
      fetch: runtimeFetch,
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        return undefined;
      },
    };

    createZaiClient(runtime as never, { fetch: explicitFetch });

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: explicitFetch })
    );
  });

  it("omits apiKey when only a browser proxy base URL is configured", async () => {
    const { createZaiClient } = await import("../providers/openai-compatible");
    const originalDocument = globalThis.document;
    delete process.env.ZAI_API_KEY;
    delete process.env.Z_AI_API_KEY;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {},
    });
    const runtime = {
      getSetting(key: string) {
        if (key === "ZAI_BROWSER_BASE_URL") return "https://proxy.example.test/zai";
        return undefined;
      },
    };

    try {
      createZaiClient(runtime as never);

      expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
        expect.not.objectContaining({ apiKey: expect.any(String) })
      );
      expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: "https://proxy.example.test/zai" })
      );
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: originalDocument,
      });
    }
  });
});
