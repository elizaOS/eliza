/** Exercises mobile BGE routing and admission with the real shared tokenizer and a controlled native boundary. */
import { BGE_SMALL_VECTOR_SPACE, getEmbeddingVectorSpace } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { prepareBgeEmbeddingInput } from "../model-catalog/bge-input.js";

const originalCapacitor = Object.getOwnPropertyDescriptor(
  globalThis,
  "Capacitor",
);
afterEach(() => {
  vi.doUnmock("llama-cpp-capacitor");
  vi.resetModules();
  if (originalCapacitor)
    Object.defineProperty(globalThis, "Capacitor", originalCapacitor);
  else Reflect.deleteProperty(globalThis, "Capacitor");
});

it.each(["android", "ios"])(
  "admits the unchanged tail through the dedicated %s encoder and rejects token disagreement before inference",
  async (platform) => {
    vi.resetModules();
    Object.defineProperty(globalThis, "Capacitor", {
      configurable: true,
      value: {
        isNativePlatform: () => true,
        getPlatform: () => platform,
      },
    });
    let mismatch = false;
    const embedding = vi.fn(async (text: string) => ({
      embedding: [1, ...Array(383).fill(0)],
      tokens: prepareBgeEmbeddingInput(text).tokenIds.length,
      tokenIds: prepareBgeEmbeddingInput(text).tokenIds,
      embeddingSpace: BGE_SMALL_VECTOR_SPACE,
    }));
    const release = vi.fn(async () => undefined);
    const initialize = vi.fn(async () => ({
      tokenize: async (text: string) => {
        const ids = prepareBgeEmbeddingInput(text).tokenIds;
        if (mismatch) ids[1] = ids[1] === 100 ? 101 : 100;
        return { tokens: ids };
      },
      embedding,
      release,
    }));
    vi.doMock("llama-cpp-capacitor", () => ({ initBgeEmbedding: initialize }));
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");
    const adapter = new CapacitorLlamaAdapter();
    await Promise.all([
      adapter.load({
        modelPath: "/models/bge-small-en-v1.5-f16.gguf",
        contextSize: 512,
      }),
      adapter.load({
        modelPath: "/models/bge-small-en-v1.5-f16.gguf",
        contextSize: 512,
      }),
    ]);
    expect(initialize).toHaveBeenCalledTimes(1);
    const input = `${"discarded beginning ".repeat(700)}the intended search ends here`;
    const prepared = prepareBgeEmbeddingInput(input);
    await adapter.load({
      modelPath: "/models/bge-small-en-v1.5-f16.gguf",
      contextSize: 512,
    });
    expect(release).not.toHaveBeenCalled();
    const result = await adapter.embed({ input });
    expect(prepared.text.length).toBeLessThan(input.length);
    expect(input.endsWith(prepared.text)).toBe(true);
    expect(getEmbeddingVectorSpace(result.embedding)).toBe(
      BGE_SMALL_VECTOR_SPACE,
    );
    expect(embedding).toHaveBeenCalledWith(prepared.text, {
      expectedTokenIds: prepared.tokenIds,
      embeddingSpace: BGE_SMALL_VECTOR_SPACE,
    });
    mismatch = true;
    await expect(adapter.embed({ input })).rejects.toMatchObject({
      code: "EMBEDDING_TOKENIZER_MISMATCH",
    });
    expect(embedding).toHaveBeenCalledTimes(1);
    mismatch = false;
    await expect(
      adapter.embed({
        input,
        expectedTokenIds: [101, 100, 102],
        embeddingSpace: BGE_SMALL_VECTOR_SPACE,
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_TOKENIZER_MISMATCH" });
    expect(embedding).toHaveBeenCalledTimes(1);
    await adapter.unload();
    expect(release).toHaveBeenCalledTimes(1);
  },
);

it.each(["tokenize", "embedding"])(
  "keeps the BGE context alive when unload arrives during %s",
  async (phase) => {
    vi.resetModules();
    Object.defineProperty(globalThis, "Capacitor", {
      configurable: true,
      value: { isNativePlatform: () => true, getPlatform: () => "android" },
    });
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const release = vi.fn(async () => undefined);
    const pause = async (operation: string) => {
      if (phase === operation) {
        started.resolve();
        await resume.promise;
      }
    };
    vi.doMock("llama-cpp-capacitor", () => ({
      initBgeEmbedding: async () => ({
        tokenize: async (text: string) => {
          await pause("tokenize");
          return { tokens: prepareBgeEmbeddingInput(text).tokenIds };
        },
        embedding: async (text: string) => {
          await pause("embedding");
          const tokenIds = prepareBgeEmbeddingInput(text).tokenIds;
          return {
            embedding: [1, ...Array(383).fill(0)],
            tokens: tokenIds.length,
            tokenIds,
            embeddingSpace: BGE_SMALL_VECTOR_SPACE,
          };
        },
        release,
      }),
    }));
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");
    const adapter = new CapacitorLlamaAdapter();
    await adapter.load({ modelPath: "/models/bge-small-en-v1.5-f16.gguf" });
    const pending = adapter.embed({ input: "preserve this embedding request" });
    const observed = Promise.allSettled([pending]);
    await started.promise;
    const unloading = adapter.unload();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(release).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await observed;
      await unloading;
    }
    expect(getEmbeddingVectorSpace((await pending).embedding)).toBe(
      BGE_SMALL_VECTOR_SPACE,
    );
    expect(release).toHaveBeenCalledTimes(1);
  },
);

it.each([
  { bridge: {}, code: "EMBEDDING_BACKEND_UNAVAILABLE" },
  { bridge: { initBgeEmbedding: true }, code: "EMBEDDING_BACKEND_UNAVAILABLE" },
  {
    bridge: { initBgeEmbedding: async () => null },
    code: "EMBEDDING_BACKEND_INVALID",
  },
  {
    bridge: { initBgeEmbedding: async () => ({ tokenize() {} }) },
    code: "EMBEDDING_BACKEND_INVALID",
  },
])(
  "rejects a missing or malformed BGE capability ($code)",
  async ({ bridge, code }) => {
    vi.resetModules();
    Object.defineProperty(globalThis, "Capacitor", {
      configurable: true,
      value: { isNativePlatform: () => true, getPlatform: () => "android" },
    });
    vi.doMock("llama-cpp-capacitor", () => bridge);
    const { CapacitorLlamaAdapter } = await import("./capacitor-llama-adapter");
    const adapter = new CapacitorLlamaAdapter();
    await expect(
      adapter.load({ modelPath: "/models/bge-small-en-v1.5-f16.gguf" }),
    ).rejects.toMatchObject({ code });
    expect(await adapter.isLoaded()).toEqual({
      loaded: false,
      modelPath: null,
    });
  },
);
