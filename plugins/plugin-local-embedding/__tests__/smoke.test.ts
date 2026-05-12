import { describe, expect, it } from "vitest";

describe("@elizaos/plugin-local-embedding", () => {
  it("exports the plugin", async () => {
    const mod = await import("../src/index.ts");
    expect(mod).toBeDefined();
    expect(mod.localEmbeddingPlugin).toBeDefined();
    expect(mod.localEmbeddingPlugin.name).toBe("local-embedding");
    // Legacy alias kept so older characters that imported `localAiPlugin`
    // from this package keep working.
    expect(mod.localAiPlugin).toBe(mod.localEmbeddingPlugin);
    expect(mod.default).toBe(mod.localEmbeddingPlugin);
  }, 180_000);
});
