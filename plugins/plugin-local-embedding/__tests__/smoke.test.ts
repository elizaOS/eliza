import { describe, expect, it } from "vitest";

describe("@elizaos/plugin-local-embedding", () => {
  it("exports the unified local inference provider as a deprecated shim", async () => {
    const mod = await import("../src/index.ts");
    const localInference = await import("@elizaos/plugin-local-inference");
    expect(mod).toBeDefined();
    expect(mod.localEmbeddingPlugin).toBe(localInference.localInferencePlugin);
    expect(mod.localAiPlugin).toBe(mod.localEmbeddingPlugin);
    expect(mod.default).toBe(mod.localEmbeddingPlugin);
    expect(mod.localEmbeddingPlugin.name).toBe("eliza-local-inference");
    expect(mod.localEmbeddingPlugin.models?.TEXT_EMBEDDING).toBe(
      localInference.localInferencePlugin.models?.TEXT_EMBEDDING
    );
  }, 180_000);
});
