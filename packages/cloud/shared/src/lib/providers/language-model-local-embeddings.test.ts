/**
 * Exercises the self-hosted TEI embeddings routing branch of language-model.ts
 * (LOCAL_EMBEDDINGS_BASE_URL / ELIZA_EMBEDDINGS_FORCE_LOCAL): the local id and
 * force-local aliasing route to the sidecar, the OpenAI path is untouched when
 * the sidecar is unconfigured, the local id without a base URL is a
 * configuration error, and the mirror helpers (source resolution, configured
 * predicate, embeddings passthrough) agree with the router. Deterministic
 * harness: real module under test, env-driven, with a stubbed global fetch.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { CANONICAL_EMBEDDING_MODEL } from "@elizaos/core/edge";

const ORIGINAL_FETCH = globalThis.fetch;

process.env.OPENAI_API_KEY = "test-openai-key";
delete process.env.OPENAI_BASE_URL;
delete process.env.LOCAL_EMBEDDINGS_BASE_URL;
delete process.env.LOCAL_EMBEDDINGS_API_KEY;
delete process.env.ELIZA_EMBEDDINGS_FORCE_LOCAL;

mock.module("@/lib/utils/logger", () => ({
  logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
}));

const { embed } = await import("ai");

const {
  CANONICAL_CLOUD_EMBEDDING_MODEL_ID,
  getTextEmbeddingModel,
  hasTextEmbeddingProviderConfigured,
  resolveEmbeddingProviderSource,
  resolvePassthroughEmbeddingsUpstream,
  isProviderConfigurationError,
  LOCAL_EMBEDDING_MODEL_ID,
  ProviderConfigurationError,
} = await import("./language-model");

interface CapturedRequest {
  url: string;
  model: string;
  authorization: string | null;
}

function stubEmbeddingsFetch(captured: CapturedRequest[]): void {
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    captured.push({
      url: String(url),
      model: body.model,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(
      JSON.stringify({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] }],
        model: body.model,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.OPENAI_API_KEY = "test-openai-key";
  delete process.env.LOCAL_EMBEDDINGS_BASE_URL;
  delete process.env.LOCAL_EMBEDDINGS_API_KEY;
  delete process.env.ELIZA_EMBEDDINGS_FORCE_LOCAL;
});

describe("getTextEmbeddingModel local-sidecar routing", () => {
  test("managed env's full canonical model routes only to the BGE sidecar", async () => {
    process.env.LOCAL_EMBEDDINGS_BASE_URL = "http://tei.internal:8080";
    const managedModel = CANONICAL_EMBEDDING_MODEL;
    const captured: CapturedRequest[] = [];
    stubEmbeddingsFetch(captured);

    expect(managedModel).toBe(CANONICAL_CLOUD_EMBEDDING_MODEL_ID);
    await embed({ model: getTextEmbeddingModel(managedModel), value: "hi" });

    expect(captured).toEqual([
      {
        url: "http://tei.internal:8080/v1/embeddings",
        model: LOCAL_EMBEDDING_MODEL_ID,
        authorization: "Bearer local",
      },
    ]);
  });

  test("local id routes to the sidecar even when OpenAI is configured", async () => {
    process.env.LOCAL_EMBEDDINGS_BASE_URL = "http://tei.internal:8080";
    const captured: CapturedRequest[] = [];
    stubEmbeddingsFetch(captured);

    const result = await embed({
      model: getTextEmbeddingModel(LOCAL_EMBEDDING_MODEL_ID),
      value: "hi",
    });

    expect(result.embedding.length).toBe(3);
    expect(captured[0]?.url).toBe("http://tei.internal:8080/v1/embeddings");
    expect(captured[0]?.model).toBe(LOCAL_EMBEDDING_MODEL_ID);
  });

  test("force-local aliases every id onto the sidecar's model", async () => {
    process.env.LOCAL_EMBEDDINGS_BASE_URL = "http://tei.internal:8080/v1";
    process.env.ELIZA_EMBEDDINGS_FORCE_LOCAL = "true";
    const captured: CapturedRequest[] = [];
    stubEmbeddingsFetch(captured);

    await embed({
      model: getTextEmbeddingModel("text-embedding-3-small"),
      value: "hi",
    });

    // The /v1 suffix is not doubled and the upstream id is always the local one.
    expect(captured[0]?.url).toBe("http://tei.internal:8080/v1/embeddings");
    expect(captured[0]?.model).toBe(LOCAL_EMBEDDING_MODEL_ID);
  });

  test("base URL unset leaves the OpenAI path unchanged", async () => {
    const captured: CapturedRequest[] = [];
    stubEmbeddingsFetch(captured);

    await embed({
      model: getTextEmbeddingModel("text-embedding-3-small"),
      value: "hi",
    });

    expect(captured[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(captured[0]?.model).toBe("text-embedding-3-small");
  });

  test("force-local without a base URL is inert (OpenAI still serves)", async () => {
    process.env.ELIZA_EMBEDDINGS_FORCE_LOCAL = "true";
    const captured: CapturedRequest[] = [];
    stubEmbeddingsFetch(captured);

    await embed({
      model: getTextEmbeddingModel("text-embedding-3-small"),
      value: "hi",
    });

    expect(captured[0]?.url).toBe("https://api.openai.com/v1/embeddings");
  });

  test("local id without a base URL is a configuration error, not an OpenAI 404", () => {
    let thrown: unknown;
    try {
      getTextEmbeddingModel(LOCAL_EMBEDDING_MODEL_ID);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderConfigurationError);
    expect(isProviderConfigurationError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain("LOCAL_EMBEDDINGS_BASE_URL");
  });

  test("full canonical id without a sidecar fails before OpenAI dispatch", () => {
    const captured: CapturedRequest[] = [];
    stubEmbeddingsFetch(captured);

    expect(() => getTextEmbeddingModel(CANONICAL_CLOUD_EMBEDDING_MODEL_ID)).toThrow(
      ProviderConfigurationError,
    );
    expect(captured).toHaveLength(0);
  });

  test("sidecar auth: dummy bearer by default, LOCAL_EMBEDDINGS_API_KEY when set", async () => {
    process.env.LOCAL_EMBEDDINGS_BASE_URL = "http://tei.internal:8080";
    const captured: CapturedRequest[] = [];
    stubEmbeddingsFetch(captured);

    await embed({ model: getTextEmbeddingModel(LOCAL_EMBEDDING_MODEL_ID), value: "hi" });
    expect(captured[0]?.authorization).toBe("Bearer local");

    process.env.LOCAL_EMBEDDINGS_API_KEY = "tei-secret";
    await embed({ model: getTextEmbeddingModel(LOCAL_EMBEDDING_MODEL_ID), value: "hi" });
    expect(captured[1]?.authorization).toBe("Bearer tei-secret");
  });
});

describe("mirror helpers agree with the router", () => {
  test("resolveEmbeddingProviderSource follows the same precedence", () => {
    expect(resolveEmbeddingProviderSource()).toBe("openai");
    expect(resolveEmbeddingProviderSource(LOCAL_EMBEDDING_MODEL_ID)).toBeNull();
    expect(resolveEmbeddingProviderSource(CANONICAL_CLOUD_EMBEDDING_MODEL_ID)).toBeNull();

    process.env.LOCAL_EMBEDDINGS_BASE_URL = "http://tei.internal:8080";
    expect(resolveEmbeddingProviderSource(LOCAL_EMBEDDING_MODEL_ID)).toBe("selfhosted");
    expect(resolveEmbeddingProviderSource(CANONICAL_CLOUD_EMBEDDING_MODEL_ID)).toBe("selfhosted");
    expect(resolveEmbeddingProviderSource("text-embedding-3-small")).toBe("openai");
    expect(resolveEmbeddingProviderSource()).toBe("openai");

    process.env.ELIZA_EMBEDDINGS_FORCE_LOCAL = "true";
    expect(resolveEmbeddingProviderSource()).toBe("selfhosted");
    expect(resolveEmbeddingProviderSource("text-embedding-3-small")).toBe("selfhosted");
  });

  test("hasTextEmbeddingProviderConfigured follows the same precedence", () => {
    expect(hasTextEmbeddingProviderConfigured()).toBe(true);
    expect(hasTextEmbeddingProviderConfigured(LOCAL_EMBEDDING_MODEL_ID)).toBe(false);
    expect(hasTextEmbeddingProviderConfigured(CANONICAL_CLOUD_EMBEDDING_MODEL_ID)).toBe(false);

    process.env.LOCAL_EMBEDDINGS_BASE_URL = "http://tei.internal:8080";
    expect(hasTextEmbeddingProviderConfigured(LOCAL_EMBEDDING_MODEL_ID)).toBe(true);
    expect(hasTextEmbeddingProviderConfigured(CANONICAL_CLOUD_EMBEDDING_MODEL_ID)).toBe(true);

    delete process.env.OPENAI_API_KEY;
    expect(hasTextEmbeddingProviderConfigured("text-embedding-3-small")).toBe(false);
    process.env.ELIZA_EMBEDDINGS_FORCE_LOCAL = "true";
    expect(hasTextEmbeddingProviderConfigured()).toBe(true);
    expect(hasTextEmbeddingProviderConfigured("text-embedding-3-small")).toBe(true);
  });

  test("embeddings passthrough stands down whenever the sidecar claims the model", () => {
    expect(resolvePassthroughEmbeddingsUpstream("text-embedding-3-small")).not.toBeNull();
    // The local-only id never goes to OpenAI, configured sidecar or not.
    expect(resolvePassthroughEmbeddingsUpstream(LOCAL_EMBEDDING_MODEL_ID)).toBeNull();
    expect(resolvePassthroughEmbeddingsUpstream(CANONICAL_CLOUD_EMBEDDING_MODEL_ID)).toBeNull();

    process.env.LOCAL_EMBEDDINGS_BASE_URL = "http://tei.internal:8080";
    expect(resolvePassthroughEmbeddingsUpstream(LOCAL_EMBEDDING_MODEL_ID)).toBeNull();
    expect(resolvePassthroughEmbeddingsUpstream("text-embedding-3-small")).not.toBeNull();

    process.env.ELIZA_EMBEDDINGS_FORCE_LOCAL = "true";
    expect(resolvePassthroughEmbeddingsUpstream("text-embedding-3-small")).toBeNull();
  });
});
