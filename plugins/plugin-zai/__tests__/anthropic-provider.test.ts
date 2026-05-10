import { describe, expect, it, vi } from "vitest";

const createAnthropicMock = vi.fn((config: { fetch?: typeof fetch }) => config);

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock,
}));

describe("z.ai Anthropic-compatible provider", () => {
  it("strips SDK-injected temperature whenever top_p is present", async () => {
    const { createAnthropicClientWithTopPSupport } = await import("../providers/anthropic");
    const runtime = {
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        return undefined;
      },
    };
    const fetchMock = vi.fn(async () => new Response("ok"));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      createAnthropicClientWithTopPSupport(runtime as never);
      const customFetch = createAnthropicMock.mock.calls.at(-1)?.[0]?.fetch;
      expect(customFetch).toBeTypeOf("function");

      await customFetch?.("https://api.z.ai/api/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify({ top_p: 0.8, temperature: 1, prompt: "hello" }),
      });

      const forwardedInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(forwardedInit.body))).toEqual({ top_p: 0.8, prompt: "hello" });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("falls back to unmodified fetch when request body is not JSON", async () => {
    const { createAnthropicClientWithTopPSupport } = await import("../providers/anthropic");
    const runtime = {
      getSetting(key: string) {
        if (key === "ZAI_API_KEY") return "test-key";
        return undefined;
      },
    };
    const fetchMock = vi.fn(async () => new Response("ok"));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      createAnthropicClientWithTopPSupport(runtime as never);
      const customFetch = createAnthropicMock.mock.calls.at(-1)?.[0]?.fetch;

      await customFetch?.("https://api.z.ai/api/anthropic/v1/messages", {
        method: "POST",
        body: "not-json",
      });

      expect(fetchMock.mock.calls[0]?.[1]).toEqual({ method: "POST", body: "not-json" });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
