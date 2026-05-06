import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProviderModels } from "./model-provider-helpers.js";

vi.mock("@elizaos/shared", () => ({
  DEFAULT_ELIZA_CLOUD_FREE_TEXT_MODEL: "openrouter/free-model",
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL: "openrouter/default-model",
}));

describe("model-provider-helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the AI Gateway API key when fetching the Vercel model catalog", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "openai/gpt-5.4", name: "GPT-5.4", type: "language" }],
        }),
      ),
    );

    const models = await fetchProviderModels(
      "vercel-ai-gateway",
      "gateway-key",
      "https://ai-gateway.vercel.sh/v1/",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://ai-gateway.vercel.sh/v1/models",
      { headers: { Authorization: "Bearer gateway-key" } },
    );
    expect(models).toEqual([
      { id: "openai/gpt-5.4", name: "GPT-5.4", category: "chat" },
    ]);
  });
});
