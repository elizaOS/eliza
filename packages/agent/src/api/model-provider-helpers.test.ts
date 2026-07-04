/**
 * Checks fetchNearAIModels (api/model-provider-helpers.ts) parses the NEAR AI
 * /models catalog — both the current `data[]` / `is_ready` shape and the legacy
 * `models[]` / `metadata` shape — skips not-ready models, and derives chat vs
 * image categories, with global fetch stubbed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNearAIModels } from "./model-provider-helpers";

describe("fetchNearAIModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the current NEAR AI /models catalog and skips not-ready models", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "google/gemma-4-31B-it",
              name: "Gemma 4 31B Instruct",
              output_modalities: ["text"],
              is_ready: true,
            },
            {
              id: "legacy/not-ready",
              name: "Not Ready",
              output_modalities: ["text"],
              is_ready: false,
            },
            {
              id: "nearai/image-model",
              name: "Image Model",
              architecture: { outputModalities: ["image"] },
              is_ready: true,
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchNearAIModels("near-key", "https://cloud-api.near.ai/v1/"),
    ).resolves.toEqual([
      {
        id: "google/gemma-4-31B-it",
        name: "Gemma 4 31B Instruct",
        category: "chat",
      },
      {
        id: "nearai/image-model",
        name: "Image Model",
        category: "image",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud-api.near.ai/v1/models",
      { headers: { Authorization: "Bearer near-key" } },
    );
  });

  it("continues to tolerate the legacy NEAR AI model-list response shape", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          models: [
            {
              modelId: "legacy/text-model",
              metadata: {
                modelDisplayName: "Legacy Text Model",
                architecture: { outputModalities: ["text"] },
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchNearAIModels("", "https://cloud-api.near.ai/v1"),
    ).resolves.toEqual([
      {
        id: "legacy/text-model",
        name: "Legacy Text Model",
        category: "chat",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud-api.near.ai/v1/models",
      { headers: {} },
    );
  });
});
