import { describe, expect, it } from "bun:test";
import {
  ModelType,
  NoModelProviderConfiguredError,
  type Plugin,
} from "@elizaos/core";
import openaiPlugin from "@elizaos/plugin-openai";
import {
  CODING_EMBEDDING_CONTRACT,
  codingEmbeddingUnavailablePlugin,
  configureCodingEmbeddingEnv,
  withoutEmbeddingModels,
} from "./coding-embedding-config.js";

function env(overrides: Record<string, string | undefined> = {}) {
  return { ...overrides };
}

describe("Eliza Code embedding configuration", () => {
  it("enables only a dedicated endpoint with a credential and pins the canonical BGE contract", () => {
    const values = env({
      EMBEDDING_BASE_URL: " https://embedding.example/v1 ",
      EMBEDDING_API_KEY: "already-authorized",
    });

    expect(configureCodingEmbeddingEnv(values)).toEqual({ enabled: true });
    expect(values.EMBEDDING_MODEL).toBe("@cf/baai/bge-small-en-v1.5");
    expect(values.EMBEDDING_DIMENSIONS).toBe("384");
    expect(values.EMBEDDING_POOLING).toBe("cls");
    expect(CODING_EMBEDDING_CONTRACT).toEqual({
      model: "@cf/baai/bge-small-en-v1.5",
      dimensions: "384",
      pooling: "cls",
    });
  });

  it.each([
    [{}, "missing_endpoint_and_credential"],
    [{ EMBEDDING_API_KEY: "authorized" }, "missing_endpoint"],
    [
      { EMBEDDING_BASE_URL: "https://embedding.example/v1" },
      "missing_credential",
    ],
  ] as const)(
    "degrades explicitly without mutating the canonical vector contract: %s",
    (overrides, reason) => {
      const values = env(overrides);

      expect(configureCodingEmbeddingEnv(values)).toEqual({
        enabled: false,
        reason,
      });
      expect(values.EMBEDDING_MODEL).toBeUndefined();
      expect(values.EMBEDDING_DIMENSIONS).toBeUndefined();
      expect(values.EMBEDDING_POOLING).toBeUndefined();
    },
  );

  it.each([
    ["EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"],
    ["EMBEDDING_DIMENSIONS", "1536"],
    ["EMBEDDING_POOLING", "mean"],
  ] as const)("rejects a mixed canonical space through %s", (key, value) => {
    const values = env({
      EMBEDDING_BASE_URL: "https://embedding.example/v1",
      EMBEDDING_API_KEY: "already-authorized",
      [key]: value,
    });

    expect(configureCodingEmbeddingEnv(values)).toEqual({
      enabled: false,
      reason: "incompatible_contract",
      setting: key,
    });
  });

  it("rejects a fallback endpoint that could mix embedding spaces", () => {
    const values = env({
      EMBEDDING_BASE_URL: "https://embedding.example/v1",
      EMBEDDING_API_KEY: "already-authorized",
      EMBEDDING_FALLBACK_BASE_URL: "https://other.example/v1",
    });

    expect(configureCodingEmbeddingEnv(values)).toEqual({
      enabled: false,
      reason: "fallback_not_allowed",
    });
  });
});

describe("Eliza Code embedding provider ownership", () => {
  it("removes the actual OpenAI/Cerebras hash embedding handler", () => {
    expect(openaiPlugin.models?.[ModelType.TEXT_EMBEDDING]).toBeDefined();

    const isolated = withoutEmbeddingModels(openaiPlugin);

    expect(isolated.models?.[ModelType.TEXT_EMBEDDING]).toBeUndefined();
    expect(openaiPlugin.models?.[ModelType.TEXT_EMBEDDING]).toBeDefined();
  });

  it("removes chat-provider single and batch embedding handlers without mutating the source plugin", () => {
    const single = async () => [1];
    const batch = async () => [[1]];
    const provider = {
      name: "chat-provider",
      models: {
        [ModelType.TEXT_EMBEDDING]: single,
        [ModelType.TEXT_EMBEDDING_BATCH]: batch,
        [ModelType.TEXT_SMALL]: async () => "ok",
      },
      modelMetadata: {
        [ModelType.TEXT_EMBEDDING]: { name: "fake" },
        [ModelType.TEXT_SMALL]: { name: "chat" },
      },
    } as unknown as Plugin;

    const isolated = withoutEmbeddingModels(provider);

    expect(isolated.models?.[ModelType.TEXT_EMBEDDING]).toBeUndefined();
    expect(isolated.models?.[ModelType.TEXT_EMBEDDING_BATCH]).toBeUndefined();
    expect(isolated.models?.[ModelType.TEXT_SMALL]).toBeDefined();
    expect(isolated.modelMetadata?.[ModelType.TEXT_EMBEDDING]).toBeUndefined();
    expect(isolated.modelMetadata?.[ModelType.TEXT_SMALL]).toBeDefined();
    expect(provider.models?.[ModelType.TEXT_EMBEDDING]).toBe(single);
    expect(provider.models?.[ModelType.TEXT_EMBEDDING_BATCH]).toBe(batch);
  });

  it("uses an explicit unavailable handler instead of a fabricated or hash vector", async () => {
    const handler =
      codingEmbeddingUnavailablePlugin.models?.[ModelType.TEXT_EMBEDDING];
    expect(handler).toBeDefined();

    await expect(handler?.({} as never, null)).rejects.toBeInstanceOf(
      NoModelProviderConfiguredError,
    );
  });
});
