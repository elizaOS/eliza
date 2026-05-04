import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "./stage-default-models.mjs";

describe("stage-default-models / DEFAULT_MODELS", () => {
  it("ships at least one chat model and one embedding model", () => {
    const chats = DEFAULT_MODELS.filter((m) => m.role === "chat");
    const embeddings = DEFAULT_MODELS.filter((m) => m.role === "embedding");
    expect(chats.length).toBeGreaterThan(0);
    expect(embeddings.length).toBeGreaterThan(0);
  });

  it("every entry has a sane size envelope (max < 1GiB, min < max)", () => {
    for (const model of DEFAULT_MODELS) {
      expect(model.expectedMinBytes).toBeGreaterThan(0);
      expect(model.expectedMaxBytes).toBeGreaterThan(model.expectedMinBytes);
      // 1 GiB upper bound: anything bigger than that should not be
      // bundled in an APK by default — APK Expansion Files / runtime
      // download territory.
      expect(model.expectedMaxBytes).toBeLessThan(1024 * 1024 * 1024);
    }
  });

  it("every entry has a non-empty hfRepo and ggufFile", () => {
    for (const model of DEFAULT_MODELS) {
      expect(model.hfRepo).toMatch(/^[^/\s]+\/[^/\s]+$/);
      expect(model.ggufFile).toMatch(/\.gguf$/);
    }
  });

  it("ids are unique", () => {
    const ids = DEFAULT_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
