import { describe, expect, test } from "bun:test";
import { CacheKeys, CacheStaleTTL, CacheTTL } from "@/lib/cache/keys";
import {
  getGroqApiModelId,
  isGroqNativeModel,
  isSelectableTextModel,
  mergeCatalogModels,
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
});

describe("model catalog caching", () => {
  test("uses a dedicated SWR cache key and timings", () => {
    expect(CacheKeys.models.openrouterCatalog()).toBe("models:openrouter-catalog:v1");
    expect(CacheTTL.models.catalog).toBe(3600);
    expect(CacheStaleTTL.models.catalog).toBe(900);
    expect(CacheStaleTTL.models.catalog).toBeLessThan(CacheTTL.models.catalog);
  });
});
