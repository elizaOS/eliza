/** Exercises four production model-provider clients against the resettable real-HTTP mock. */

import { afterEach, describe, expect, it } from "bun:test";
import type { IAgentRuntime } from "@elizaos/core";
import { handleTextEmbedding as handleConfiguredEmbedding } from "../../../../plugins/plugin-embeddings/src/models/embedding";
import { handleTextEmbedding as handleGoogleEmbedding } from "../../../../plugins/plugin-google-genai/models/embedding";
import { handleTextSmall as handleGoogleText } from "../../../../plugins/plugin-google-genai/models/text";
import { handleTextSmall as handleZaiText } from "../../../../plugins/plugin-zai/models/text";
import { handleTextEmbedding as handleOllamaEmbedding } from "../../../../plugins/plugin-zerollama/models/embedding";
import { handleTextSmall as handleOllamaText } from "../../../../plugins/plugin-zerollama/models/text";
import { clearOllamaHostFlavorCache } from "../../../../plugins/plugin-zerollama/utils/host-flavor";
import {
  MODEL_PROVIDER_MAX_REQUEST_BYTES,
  ModelProviderMockStore,
  startModelProviderMock,
} from "../src/model-provider";
import type { ModelProviderSeed } from "../src/model-provider/types";

const vector = (length: number, offset = 0) =>
  Array.from(
    { length },
    (_, index) => (index + 1 + offset) / (length + offset + 1),
  );
const configuredAlpha = vector(384);
const configuredBeta = vector(384, 1);
const googleEmbedding = [1, ...Array(767).fill(0)];
const ollamaEmbedding = vector(384);
const baseOllamaSeed: NonNullable<ModelProviderSeed["ollama"]> = {
  distribution: "zerollama",
  models: ["synthetic-text", "synthetic-embed"],
  text: "ollama synthetic answer",
  streamChunks: ["ollama ", "synthetic ", "answer"],
  embedding: ollamaEmbedding,
  promptTokens: 5,
  completionTokens: 3,
};

const baseSeed: ModelProviderSeed = {
  auth: {
    "configured-embedding": "embedding-key",
    google: "google-key",
    zai: "zai-key",
  },
  configuredEmbedding: {
    model: "synthetic-embedding",
    dimensions: 384,
    vectors: { alpha: configuredAlpha, beta: configuredBeta },
    promptTokens: 4,
  },
  google: {
    text: "google synthetic answer",
    embedding: googleEmbedding,
    inputTokens: 7,
    outputTokens: 3,
  },
  ollama: baseOllamaSeed,
  zai: {
    model: "glm-synthetic",
    text: "z.ai synthetic answer",
    promptTokens: 6,
    completionTokens: 4,
  },
};

const running: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  clearOllamaHostFlavorCache();
  await Promise.all(running.splice(0).map((server) => server.stop()));
});

function runtime(settings: Record<string, string>): IAgentRuntime {
  const trajectoryLogger = {
    isEnabled: () => false,
    logLlmCall: () => undefined,
  };
  return {
    agentId: "synthetic-model-agent",
    character: {
      name: "Ada",
      system: "Answer from the deterministic synthetic world.",
    },
    emitEvent: async () => undefined,
    getService: (name: string) =>
      name === "trajectories" ? trajectoryLogger : null,
    getServicesByType: (type: string) =>
      type === "trajectories" ? [trajectoryLogger] : [],
    getSetting: (key: string) => settings[key] ?? null,
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

async function start(seed: ModelProviderSeed = baseSeed) {
  const server = await startModelProviderMock({ seed });
  running.push(server);
  return server;
}

describe("model-provider production protocol mocks", () => {
  it("drives configured embeddings through real fetch with dimensions, usage, auth redaction, and reset", async () => {
    const server = await start();
    const agent = runtime({
      EMBEDDING_BASE_URL: server.configuredEmbeddingBaseUrl,
      EMBEDDING_API_KEY: "embedding-key",
      EMBEDDING_MODEL: "synthetic-embedding",
      EMBEDDING_DIMENSIONS: "384",
    });

    const result = await handleConfiguredEmbedding(agent, { text: "alpha" });
    expect(result).toEqual(configuredAlpha);

    const readback = server.store.readback();
    expect(readback.observations).toHaveLength(1);
    expect(readback.observations[0]).toMatchObject({
      operation: "configured-embedding",
      status: 200,
      headers: { authorization: "<redacted>" },
      body: {
        model: "synthetic-embedding",
        input: "alpha",
        dimensions: 384,
      },
    });
    expect(JSON.stringify(readback)).not.toContain("embedding-key");

    const priorGeneration = readback.generation;
    expect(server.store.reset()).toBe(priorGeneration + 1);
    expect(server.store.readback().observations).toEqual([]);
  });

  it("bounds adversarial provider bodies and redacts alternate credential carriers", async () => {
    const server = await start();
    const oversized = await fetch(
      `${server.zaiBaseUrl}/chat/completions?access_token=query-secret&api_key=other-secret`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "header-secret",
        },
        body: JSON.stringify({
          model: "glm-synthetic",
          prompt: "x".repeat(MODEL_PROVIDER_MAX_REQUEST_BYTES),
        }),
      },
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      error: {
        code: "REQUEST_TOO_LARGE",
        message: "invalid provider request",
      },
    });
    const oversizedReadback = server.store.readback();
    expect(oversizedReadback.observations[0]).toMatchObject({
      operation: "zai-chat",
      status: 413,
      headers: { "x-api-key": "<redacted>" },
      body: { invalidRequest: "REQUEST_TOO_LARGE" },
    });
    expect(oversizedReadback.observations[0]?.path).toBe(
      "/zai/chat/completions?access_token=%3Credacted%3E&api_key=%3Credacted%3E",
    );
    expect(JSON.stringify(oversizedReadback)).not.toContain("secret");

    server.store.reset();
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 66; depth += 1) nested = { nested };
    const tooDeep = await fetch(`${server.zaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(nested),
    });
    expect(tooDeep.status).toBe(413);
    expect(await tooDeep.json()).toEqual({
      error: {
        code: "JSON_TOO_COMPLEX",
        message: "invalid provider request",
      },
    });
    expect(server.store.readback().observations[0]?.body).toEqual({
      invalidRequest: "JSON_TOO_COMPLEX",
    });

    server.store.reset();
    const wrongMediaType = await fetch(
      `${server.zaiBaseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      },
    );
    expect(wrongMediaType.status).toBe(400);
    expect(await wrongMediaType.json()).toMatchObject({
      error: { code: "UNSUPPORTED_MEDIA_TYPE" },
    });

    server.store.reset();
    const compressed = await fetch(`${server.zaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-encoding": "gzip",
        "content-type": "application/json; charset=utf-8",
      },
      body: "{}",
    });
    expect(compressed.status).toBe(400);
    expect(await compressed.json()).toMatchObject({
      error: { code: "UNSUPPORTED_ENCODING" },
    });

    const boundedStore = new ModelProviderMockStore(baseSeed);
    boundedStore.record(boundedStore.generation, {
      operation: "zai-chat",
      method: "POST",
      path: "/zai/chat/completions",
      headers: {},
      body: nested,
      status: 200,
    });
    expect(boundedStore.readback().observations[0]?.body).toEqual({
      omitted: "observation body exceeded protocol bounds",
    });
  });

  it("fences a delayed old-generation Ollama mutation across reset", async () => {
    const server = await start({
      ...baseSeed,
      ollama: { ...baseOllamaSeed, models: ["old-generation-model"] },
      faults: { "ollama-model-pull": [{ type: "delay", delayMs: 100 }] },
    });
    const oldGeneration = server.store.generation;
    const pending = fetch(`${server.ollamaBaseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "must-not-cross-reset", stream: false }),
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!server.store.readback().remainingFaults["ollama-model-pull"]) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    server.store.reset({
      ...baseSeed,
      ollama: { ...baseOllamaSeed, models: ["new-generation-model"] },
      faults: { "ollama-model-pull": [{ type: "delay", delayMs: 1 }] },
    });

    expect((await pending).status).toBe(409);
    const readback = server.store.readback();
    expect(readback.ollamaModels).toEqual(["new-generation-model"]);
    expect(readback.observations).toEqual([]);
    expect(readback.remainingFaults["ollama-model-pull"]).toBe(1);
    expect(readback.staleObservations).toEqual([
      expect.objectContaining({
        generation: oldGeneration,
        operation: "ollama-model-pull",
        status: 409,
      }),
    ]);
  });

  it("surfaces auth and rate limits, retries only the configured fallback, and honors cancellation", async () => {
    const primary = await start({
      ...baseSeed,
      faults: { "configured-embedding": [{ type: "http", status: 429 }] },
    });
    const fallback = await start();
    const agent = runtime({
      EMBEDDING_BASE_URL: primary.configuredEmbeddingBaseUrl,
      EMBEDDING_API_KEY: "embedding-key",
      EMBEDDING_FALLBACK_BASE_URL: fallback.configuredEmbeddingBaseUrl,
      EMBEDDING_FALLBACK_API_KEY: "embedding-key",
      EMBEDDING_MODEL: "synthetic-embedding",
      EMBEDDING_FALLBACK_MODEL: "synthetic-embedding",
      EMBEDDING_DIMENSIONS: "384",
    });

    expect(await handleConfiguredEmbedding(agent, { text: "alpha" })).toEqual(
      configuredAlpha,
    );
    expect(primary.store.readback().observations[0]?.status).toBe(429);
    expect(fallback.store.readback().observations[0]?.status).toBe(200);

    const unauthorized = runtime({
      EMBEDDING_BASE_URL: fallback.configuredEmbeddingBaseUrl,
      EMBEDDING_API_KEY: "wrong-key",
      EMBEDDING_MODEL: "synthetic-embedding",
      EMBEDDING_DIMENSIONS: "384",
    });
    await expect(
      handleConfiguredEmbedding(unauthorized, { text: "alpha" }),
    ).rejects.toThrow(/HTTP 401/);

    fallback.store.reset({
      ...baseSeed,
      faults: { "configured-embedding": [{ type: "delay", delayMs: 500 }] },
    });
    const cancellable = runtime({
      EMBEDDING_BASE_URL: fallback.configuredEmbeddingBaseUrl,
      EMBEDDING_API_KEY: "embedding-key",
      EMBEDDING_MODEL: "synthetic-embedding",
      EMBEDDING_DIMENSIONS: "384",
    });
    const controller = new AbortController();
    const pending = handleConfiguredEmbedding(cancellable, {
      text: "alpha",
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("synthetic cancellation")), 10);
    await expect(pending).rejects.toThrow();
  });

  it("drives the production Google SDK through configured text and embedding HTTP routes", async () => {
    const server = await start();
    const agent = runtime({
      GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
      GOOGLE_GENERATIVE_AI_BASE_URL: server.googleBaseUrl,
      GOOGLE_SMALL_MODEL: "gemini-synthetic",
      GOOGLE_EMBEDDING_MODEL: "gemini-embedding-001",
    });

    expect(await handleGoogleText(agent, { prompt: "hello Google" })).toBe(
      "google synthetic answer",
    );
    expect(await handleGoogleEmbedding(agent, "embed this")).toEqual(
      googleEmbedding,
    );

    const observations = server.store.readback().observations;
    expect(observations.map(({ operation }) => operation)).toEqual([
      "google-generate",
      "google-count-tokens",
      "google-embedding",
    ]);
    expect(
      observations.every(
        ({ headers }) => headers["x-goog-api-key"] !== "google-key",
      ),
    ).toBe(true);
    expect(observations[0]?.body).toMatchObject({
      extractedText: "hello Google",
      generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
    });
    expect(observations[2]?.body).toMatchObject({
      extractedText: "embed this",
    });
  });

  it("rejects malformed Google provider output through the production SDK parser", async () => {
    const server = await start({
      ...baseSeed,
      faults: { "google-generate": [{ type: "malformed" }] },
    });
    const agent = runtime({
      GOOGLE_GENERATIVE_AI_API_KEY: "google-key",
      GOOGLE_GENERATIVE_AI_BASE_URL: server.googleBaseUrl,
      GOOGLE_SMALL_MODEL: "gemini-synthetic",
    });

    await expect(
      handleGoogleText(agent, { prompt: "malformed please" }),
    ).rejects.toThrow();
    expect(server.store.readback().observations[0]).toMatchObject({
      operation: "google-generate",
      status: 200,
    });
  });

  it("selects zerollama from the real version route, streams exact NDJSON chunks, and embeds", async () => {
    const server = await start();
    const agent = runtime({
      OLLAMA_BASE_URL: server.ollamaBaseUrl,
      OLLAMA_SMALL_MODEL: "synthetic-text",
      OLLAMA_EMBEDDING_MODEL: "synthetic-embed",
    });

    const streamed = (await handleOllamaText(agent, {
      prompt: "hello Ollama",
      stream: true,
    })) as unknown as {
      textStream: AsyncIterable<string>;
      text: Promise<string>;
    };
    const chunks: string[] = [];
    for await (const chunk of streamed.textStream) chunks.push(chunk);
    expect(chunks).toEqual(["ollama ", "synthetic ", "answer"]);
    expect(await streamed.text).toBe("ollama synthetic answer");

    expect(
      await handleOllamaEmbedding(agent, { text: "embed locally" }),
    ).toEqual(ollamaEmbedding);
    const operations = server.store
      .readback()
      .observations.map(({ operation }) => operation);
    expect(operations).toEqual([
      "ollama-model-show",
      "ollama-version",
      "ollama-chat",
      "ollama-model-show",
      "ollama-embedding",
    ]);
    const chat = server.store
      .readback()
      .observations.find(({ operation }) => operation === "ollama-chat");
    expect(chat?.body).toMatchObject({
      model: "synthetic-text",
      stream: true,
      think: false,
      options: { temperature: 0.7, num_predict: 8192 },
    });
    expect(chat?.body).not.toHaveProperty("temperature");
  });

  it("drives z.ai's production AI SDK client, including thinking selection and provider faults", async () => {
    const server = await start();
    const agent = runtime({
      ZAI_API_KEY: "zai-key",
      ZAI_BASE_URL: server.zaiBaseUrl,
      ZAI_SMALL_MODEL: "glm-synthetic",
      ZAI_THINKING_TYPE: "enabled",
    });

    expect(
      await handleZaiText(agent, { prompt: "hello z.ai", maxTokens: 32 }),
    ).toBe("z.ai synthetic answer");
    const first = server.store.readback().observations[0];
    expect(first).toMatchObject({
      operation: "zai-chat",
      status: 200,
      headers: { authorization: "<redacted>" },
      body: { model: "glm-synthetic", thinking: { type: "enabled" } },
    });
    expect(first?.body).toMatchObject({
      max_tokens: 32,
      messages: expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "hello z.ai" }),
      ]),
    });

    server.store.reset({
      ...baseSeed,
      faults: { "zai-chat": [{ type: "http", status: 429 }] },
    });
    expect(await handleZaiText(agent, { prompt: "rate limited" })).toBe(
      "z.ai synthetic answer",
    );
    expect(
      server.store.readback().observations.map(({ status }) => status),
    ).toEqual([429, 200]);

    server.store.reset({
      ...baseSeed,
      faults: { "zai-chat": [{ type: "malformed" }] },
    });
    await expect(
      handleZaiText(agent, { prompt: "malformed" }),
    ).rejects.toThrow();
  });
});
