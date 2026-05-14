import { describe, expect, it } from "vitest";
import {
  collectConfigBenchProviderSettings,
  isCerebrasBaseUrl,
  isTextEmbeddingSetupFailure,
  normalizeConfigBenchProviderName,
} from "../src/handlers/eliza.js";

describe("Eliza handler setup helpers", () => {
  it("routes OpenAI-compatible provider labels through plugin-openai", () => {
    expect(normalizeConfigBenchProviderName("cerebras")).toBe("openai");
    expect(normalizeConfigBenchProviderName("openrouter")).toBe("openai");
    expect(normalizeConfigBenchProviderName("vllm")).toBe("openai");
    expect(normalizeConfigBenchProviderName("anthropic")).toBe("anthropic");
  });

  it("keeps configured embedding backends in OpenAI-compatible settings", () => {
    const settings = collectConfigBenchProviderSettings("cerebras", {
      OPENAI_API_KEY: "sk-chat",
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      OPENAI_SMALL_MODEL: "gpt-oss-120b",
      OPENAI_LARGE_MODEL: "gpt-oss-120b",
      OPENAI_EMBEDDING_URL: "https://api.openai.com/v1",
      OPENAI_EMBEDDING_API_KEY: "sk-embedding",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      OPENAI_EMBEDDING_DIMENSIONS: "1536",
      CEREBRAS_API_KEY: "csk-chat",
    });

    expect(settings).toMatchObject({
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
      OPENAI_EMBEDDING_URL: "https://api.openai.com/v1",
      OPENAI_EMBEDDING_API_KEY: "sk-embedding",
      OPENAI_EMBEDDING_MODEL: "text-embedding-3-small",
      OPENAI_EMBEDDING_DIMENSIONS: "1536",
      CEREBRAS_API_KEY: "csk-chat",
    });
  });

  it("classifies embedding backend setup failures", () => {
    expect(isCerebrasBaseUrl("https://api.cerebras.ai/v1")).toBe(true);
    expect(
      isTextEmbeddingSetupFailure(
        new Error(
          "[local-inference] Active local backend does not implement TEXT_EMBEDDING",
        ),
      ),
    ).toBe(true);
    expect(isTextEmbeddingSetupFailure(new Error("planner parse failed"))).toBe(
      false,
    );
  });
});
