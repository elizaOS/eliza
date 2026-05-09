import { describe, expect, test } from "bun:test";
import { CacheKeys, CacheStaleTTL, CacheTTL } from "@/lib/cache/keys";
import {
  FALLBACK_TEXT_SELECTOR_MODELS,
  getGroqApiModelId,
  isGroqNativeModel,
  isSelectableTextModel,
  isVastNativeModel,
  mergeCatalogModels,
  OPENROUTER_DEFAULT_FREE_MODEL,
  OPENROUTER_RECOMMENDED_TEXT_MODEL,
} from "@/lib/models";

describe("Groq catalog helpers", () => {
  test("recognizes Groq native model ids", () => {
    expect(isGroqNativeModel("groq/compound")).toBe(true);
    expect(isGroqNativeModel("groq/compound-mini")).toBe(true);
    expect(isGroqNativeModel("openai/gpt-5.4")).toBe(false);
  });

  test("maps Groq public ids to API ids", () => {
    expect(getGroqApiModelId("groq/compound")).toBe("compound-beta");
    expect(getGroqApiModelId("groq/compound-mini")).toBe("compound-beta-mini");
    expect(getGroqApiModelId("openai/gpt-5.4")).toBe("openai/gpt-5.4");
  });
});

describe("Vast catalog helpers", () => {
  test("recognizes static Vast native model ids", () => {
    expect(isVastNativeModel("vast/qwen3.6-27b-neo-code")).toBe(true);
    expect(isVastNativeModel("vast/qwen3.5-4b-dflash")).toBe(true);
    expect(isVastNativeModel("vast/qwen3.5-9b-dflash")).toBe(true);
    expect(isVastNativeModel("vast/qwen3.6-27b-dflash")).toBe(true);
    expect(isVastNativeModel("vast/eliza-1-9b")).toBe(true);
    expect(isVastNativeModel("vast/eliza-1-27b")).toBe(true);
    expect(isVastNativeModel("openai/gpt-5.4")).toBe(false);
  });
});

describe("text model selection filter", () => {
  test("keeps current chat-capable language models", () => {
    expect(
      isSelectableTextModel({
        id: "openai/gpt-5.4",
        object: "model",
        created: 0,
        owned_by: "openai",
        type: "language",
      }),
    ).toBe(true);

    expect(
      isSelectableTextModel({
        id: "anthropic/claude-sonnet-4.6",
        object: "model",
        created: 0,
        owned_by: "anthropic",
        type: "language",
      }),
    ).toBe(true);

    expect(
      isSelectableTextModel({
        id: "google/gemini-3-flash",
        object: "model",
        created: 0,
        owned_by: "google",
        type: "language",
      }),
    ).toBe(true);

    expect(
      isSelectableTextModel({
        id: "groq/compound",
        object: "model",
        created: 0,
        owned_by: "groq",
        type: "language",
      }),
    ).toBe(true);
  });

  test("filters non-chat models out of the selector", () => {
    expect(
      isSelectableTextModel({
        id: "openai/text-embedding-3-small",
        object: "model",
        created: 0,
        owned_by: "openai",
        type: "embedding",
      }),
    ).toBe(false);

    expect(
      isSelectableTextModel({
        id: "google/gemini-3.1-flash-image-preview",
        object: "model",
        created: 0,
        owned_by: "google",
        type: "language",
      }),
    ).toBe(false);

    expect(
      isSelectableTextModel({
        id: "openai/gpt-3.5-turbo-instruct",
        object: "model",
        created: 0,
        owned_by: "openai",
        type: "language",
      }),
    ).toBe(false);

    expect(
      isSelectableTextModel({
        id: "meta-llama/llama-prompt-guard-2-22m",
        object: "model",
        created: 0,
        owned_by: "meta-llama",
        type: "language",
      }),
    ).toBe(false);

    expect(
      isSelectableTextModel({
        id: "black-forest-labs/flux-kontext-max",
        object: "model",
        created: 0,
        owned_by: "black-forest-labs",
        type: "language",
        architecture: {
          output_modalities: ["image"],
        },
      }),
    ).toBe(false);
  });
});

describe("catalog merging", () => {
  test("deduplicates models by id when supplementing a provider catalog", () => {
    const merged = mergeCatalogModels(
      [
        {
          id: "openai/gpt-5.4",
          object: "model",
          created: 1,
          owned_by: "openai",
        },
      ],
      [
        {
          id: "openai/gpt-5.4",
          object: "model",
          created: 2,
          owned_by: "openai",
        },
        {
          id: "groq/compound",
          object: "model",
          created: 0,
          owned_by: "groq",
        },
      ],
    );

    expect(merged).toHaveLength(2);
    expect(merged.map((model) => model.id)).toEqual(["openai/gpt-5.4", "groq/compound"]);
  });

  test("annotates recommended and free OpenRouter models", () => {
    const merged = mergeCatalogModels(
      [
        {
          id: OPENROUTER_DEFAULT_FREE_MODEL,
          object: "model",
          created: 1,
          owned_by: "openai",
          pricing: { prompt: "0", completion: "0" },
        },
      ],
      [
        {
          id: OPENROUTER_RECOMMENDED_TEXT_MODEL,
          object: "model",
          created: 0,
          owned_by: "openai",
        },
      ],
    );

    expect(merged.find((model) => model.id === OPENROUTER_DEFAULT_FREE_MODEL)?.free).toBe(true);
    expect(merged.find((model) => model.id === OPENROUTER_DEFAULT_FREE_MODEL)?.tags).toContain(
      "free",
    );
    expect(
      merged.find((model) => model.id === OPENROUTER_RECOMMENDED_TEXT_MODEL)?.recommended,
    ).toBe(true);
  });
});

describe("fallback selector catalog", () => {
  test("includes recommended and free OpenRouter GPT OSS models", () => {
    const recommended = FALLBACK_TEXT_SELECTOR_MODELS.find(
      (model) => model.modelId === OPENROUTER_RECOMMENDED_TEXT_MODEL,
    );
    const free = FALLBACK_TEXT_SELECTOR_MODELS.find(
      (model) => model.modelId === OPENROUTER_DEFAULT_FREE_MODEL,
    );

    expect(recommended?.recommended).toBe(true);
    expect(free?.free).toBe(true);
  });
});

describe("model catalog caching", () => {
  test("uses a dedicated SWR cache key and timings", () => {
    expect(CacheKeys.models.openrouterCatalog()).toBe("models:openrouter-catalog:v1");
    expect(CacheTTL.models.catalog).toBe(3600);
    expect(CacheStaleTTL.models.catalog).toBe(900);
    expect(CacheStaleTTL.models.catalog).toBeLessThan(CacheTTL.models.catalog);
  });
});
