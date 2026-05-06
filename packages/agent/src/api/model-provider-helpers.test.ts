import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchOpenRouterModels,
  paramKeyToCategory,
} from "./model-provider-helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OpenRouter model discovery", () => {
  it("buckets text, free, embeddings, vision, and image generation from the models endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url !== "https://openrouter.ai/api/v1/models?output_modalities=all") {
        return new Response("not found", { status: 404 });
      }
      return Response.json({
        data: [
          {
            id: "openai/gpt-5.5",
            name: "GPT-5.5",
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"],
              modality: "text->text",
            },
          },
          {
            id: "meta-llama/llama-3.3-70b-instruct:free",
            name: "Llama 3.3 70B Free",
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text"],
              modality: "text->text",
            },
          },
          {
            id: "openai/text-embedding-3-small",
            name: "Text Embedding 3 Small",
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["embeddings"],
              modality: "text->embeddings",
            },
          },
          {
            id: "openai/gpt-4o",
            name: "GPT-4o",
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
              modality: "text+image->text",
            },
          },
          {
            id: "google/gemini-2.5-flash-image-preview",
            name: "Gemini 2.5 Flash Image",
            architecture: {
              input_modalities: ["text"],
              output_modalities: ["text", "image"],
              modality: "text->image",
            },
          },
        ],
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const models = await fetchOpenRouterModels("sk-or-test");
    const byIdAndCategory = new Set(
      models.map((model) => `${model.id}:${model.category}`),
    );

    expect(byIdAndCategory).toContain("openai/gpt-5.5:chat");
    expect(byIdAndCategory).toContain(
      "meta-llama/llama-3.3-70b-instruct:free:free",
    );
    expect(byIdAndCategory).toContain(
      "openai/text-embedding-3-small:embedding",
    );
    expect(byIdAndCategory).toContain("openai/gpt-4o:chat");
    expect(byIdAndCategory).toContain("openai/gpt-4o:vision");
    expect(byIdAndCategory).toContain(
      "google/gemini-2.5-flash-image-preview:imageGeneration",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps image model fields to vision and generation buckets separately", () => {
    expect(paramKeyToCategory("OPENROUTER_IMAGE_MODEL")).toBe("vision");
    expect(paramKeyToCategory("OPENROUTER_IMAGE_GENERATION_MODEL")).toBe(
      "imageGeneration",
    );
    expect(paramKeyToCategory("AI_GATEWAY_IMAGE_MODEL")).toBe(
      "imageGeneration",
    );
    expect(paramKeyToCategory("OPENROUTER_EMBEDDING_MODEL")).toBe("embedding");
    expect(paramKeyToCategory("OPENROUTER_SMALL_MODEL")).toBe("chat");
  });
});
