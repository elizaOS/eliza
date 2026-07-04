/**
 * Unit tests for `createNearAIClient` with `@ai-sdk/openai-compatible` mocked:
 * asserts the endpoint/key/usage settings passed to the provider and that an
 * injected runtime fetch is forwarded.
 */
import { describe, expect, it, vi } from "vitest";

const createOpenAICompatibleMock = vi.fn((config: unknown) => config);

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

describe("NEAR AI OpenAI-compatible provider", () => {
  it("uses the general NEAR AI API endpoint", async () => {
    const { createNearAIClient } = await import("../providers/openai-compatible");
    const runtime = {
      getSetting(key: string) {
        if (key === "NEARAI_API_KEY") return "test-key";
        return undefined;
      },
    };

    createNearAIClient(runtime as never);

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "nearai",
        baseURL: "https://cloud-api.near.ai/v1",
        apiKey: "test-key",
        includeUsage: true,
      })
    );
  });

  it("uses runtime fetch when provided", async () => {
    const { createNearAIClient } = await import("../providers/openai-compatible");
    const fetchMock = vi.fn(async () => new Response("ok")) as typeof fetch;
    const runtime = {
      fetch: fetchMock,
      getSetting(key: string) {
        if (key === "NEARAI_API_KEY") return "test-key";
        return undefined;
      },
    };

    createNearAIClient(runtime as never);

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: fetchMock })
    );
  });
});
