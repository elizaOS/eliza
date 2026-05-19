import { describe, expect, it, vi } from "vitest";

const createOpenAICompatibleMock = vi.fn((config: unknown) => config);

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: createOpenAICompatibleMock,
}));

describe("z.ai OpenAI-compatible provider", () => {
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
});
