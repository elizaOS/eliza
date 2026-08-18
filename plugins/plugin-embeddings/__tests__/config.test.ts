/** Unit tests for EMBEDDING_* config resolution (base URL, key, model, dimensions) against a stubbed runtime. */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  allowUnsafeUnattestedEmbeddingResponse,
  getEmbeddingApiKey,
  getEmbeddingBaseURL,
  getEmbeddingDimensions,
  getEmbeddingFallbackApiKey,
  getEmbeddingFallbackBaseURL,
  getEmbeddingFallbackModel,
  getEmbeddingModel,
  getEmbeddingPooling,
  hasEmbeddingConfig,
} from "../src/utils/config";

type Setting = string | number | boolean | null;
function makeRuntime(settings: Record<string, Setting> = {}): IAgentRuntime {
  return {
    getSetting: (key: string) => (key in settings ? settings[key] : null),
  } as unknown as IAgentRuntime;
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("plugin-embeddings config", () => {
  it("returns undefined base URL when nothing is configured (no default endpoint)", () => {
    expect(getEmbeddingBaseURL(makeRuntime())).toBeUndefined();
  });

  it("reads and trims EMBEDDING_BASE_URL", () => {
    expect(getEmbeddingBaseURL(makeRuntime({ EMBEDDING_BASE_URL: "  https://x/v1  " }))).toBe(
      "https://x/v1"
    );
  });

  it("does NOT fall back to a chat provider base URL", () => {
    // Only an unrelated chat-provider var is set — the embedding URL stays unset.
    expect(getEmbeddingBaseURL(makeRuntime({ OPENAI_BASE_URL: "https://api.openai.com/v1" }))).toBe(
      undefined
    );
  });

  it("reads EMBEDDING_API_KEY", () => {
    expect(getEmbeddingApiKey(makeRuntime({ EMBEDDING_API_KEY: "k-123" }))).toBe("k-123");
    expect(getEmbeddingApiKey(makeRuntime())).toBeUndefined();
  });

  it("defaults the model to BAAI/bge-small-en-v1.5", () => {
    expect(getEmbeddingModel(makeRuntime())).toBe("BAAI/bge-small-en-v1.5");
    expect(getEmbeddingModel(makeRuntime({ EMBEDDING_MODEL: "voyage-3" }))).toBe("voyage-3");
  });

  it("reads fallback endpoint settings without making them activation keys", () => {
    const runtime = makeRuntime({
      EMBEDDING_MODEL: "primary-model",
      EMBEDDING_FALLBACK_BASE_URL: "  https://fallback/v1  ",
      EMBEDDING_FALLBACK_API_KEY: "fallback-key",
      EMBEDDING_FALLBACK_MODEL: "fallback-model",
    });

    expect(getEmbeddingFallbackBaseURL(runtime)).toBe("https://fallback/v1");
    expect(getEmbeddingFallbackApiKey(runtime)).toBe("fallback-key");
    expect(getEmbeddingFallbackModel(runtime)).toBe("fallback-model");
    expect(
      hasEmbeddingConfig(makeRuntime({ EMBEDDING_FALLBACK_BASE_URL: "https://fallback/v1" }))
    ).toBe(false);
  });

  it("defaults the fallback model to the primary embedding model", () => {
    expect(getEmbeddingFallbackModel(makeRuntime({ EMBEDDING_MODEL: "primary-model" }))).toBe(
      "primary-model"
    );
  });

  it("defaults dimensions to 384", () => {
    expect(getEmbeddingDimensions(makeRuntime())).toBe(384);
    expect(getEmbeddingDimensions(makeRuntime({ EMBEDDING_DIMENSIONS: "384" }))).toBe(384);
  });

  it("defaults pooling to CLS while still exposing stale operator values for fail-closed validation", () => {
    expect(getEmbeddingPooling(makeRuntime())).toBe("cls");
    expect(getEmbeddingPooling(makeRuntime({ EMBEDDING_POOLING: "mean" }))).toBe("mean");
  });

  it("keeps the unattested-response escape hatch off unless explicitly enabled", () => {
    expect(allowUnsafeUnattestedEmbeddingResponse(makeRuntime())).toBe(false);
    expect(
      allowUnsafeUnattestedEmbeddingResponse(
        makeRuntime({ EMBEDDING_UNSAFE_ALLOW_UNATTESTED_RESPONSE: "true" })
      )
    ).toBe(true);
  });

  it("hasEmbeddingConfig is true when EITHER url or key is set", () => {
    expect(hasEmbeddingConfig(makeRuntime())).toBe(false);
    expect(hasEmbeddingConfig(makeRuntime({ EMBEDDING_BASE_URL: "https://x/v1" }))).toBe(true);
    expect(hasEmbeddingConfig(makeRuntime({ EMBEDDING_API_KEY: "k" }))).toBe(true);
  });

  it("falls back to process.env when the runtime setting is absent", () => {
    process.env.EMBEDDING_BASE_URL = "https://env-host/v1";
    expect(getEmbeddingBaseURL(makeRuntime())).toBe("https://env-host/v1");
  });

  it("per-character runtime setting wins over process.env", () => {
    process.env.EMBEDDING_MODEL = "env-model";
    expect(getEmbeddingModel(makeRuntime({ EMBEDDING_MODEL: "char-model" }))).toBe("char-model");
  });
});
