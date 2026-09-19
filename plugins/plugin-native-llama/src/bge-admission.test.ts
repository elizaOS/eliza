/** Exercises mobile BGE routing and admission with the real shared tokenizer and a controlled native boundary. */
import { BGE_SMALL_VECTOR_SPACE, getEmbeddingVectorSpace } from "@elizaos/core";
import { prepareBgeEmbeddingInput } from "@elizaos/shared/local-inference/bge-input";
import { afterEach, expect, it, vi } from "vitest";

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
