import { describe, expect, it } from "vitest";
import {
  buildHuggingFaceResolveUrl,
  findCatalogModel,
  MODEL_CATALOG,
} from "./catalog";
import type { ModelBucket } from "./types";

describe("catalog", () => {
  it("exposes a non-empty curated list", () => {
    expect(MODEL_CATALOG.length).toBeGreaterThan(0);
  });

  it("has unique ids across every entry", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every bucket so the hub always has something to show", () => {
    const buckets = new Set<ModelBucket>(MODEL_CATALOG.map((m) => m.bucket));
    for (const bucket of ["small", "mid", "large", "xl"] as const) {
      expect(buckets.has(bucket)).toBe(true);
    }
  });

  it("every entry declares a Q* quant and a concrete gguf filename", () => {
    for (const model of MODEL_CATALOG) {
      expect(model.quant).toMatch(/^Q\d/);
      expect(model.ggufFile).toMatch(/\.gguf$/i);
      expect(model.sizeGb).toBeGreaterThan(0);
      expect(model.minRamGb).toBeGreaterThanOrEqual(model.sizeGb);
    }
  });

  it("findCatalogModel returns the matching entry", () => {
    const target = MODEL_CATALOG[0];
    expect(target).toBeDefined();
    if (!target) return;
    expect(findCatalogModel(target.id)).toBe(target);
  });

  it("findCatalogModel returns undefined for unknown ids", () => {
    expect(findCatalogModel("does-not-exist")).toBeUndefined();
  });

  it("buildHuggingFaceResolveUrl produces an HF resolve URL with encoded filename", () => {
    const url = buildHuggingFaceResolveUrl({
      id: "test",
      displayName: "Test",
      hfRepo: "bartowski/Test-GGUF",
      ggufFile: "Test Model-Q4_K_M.gguf",
      params: "7B",
      quant: "Q4_K_M",
      sizeGb: 4,
      minRamGb: 8,
      category: "chat",
      bucket: "mid",
      blurb: "",
    });
    expect(url).toBe(
      "https://huggingface.co/bartowski/Test-GGUF/resolve/main/Test%20Model-Q4_K_M.gguf?download=true",
    );
  });
});
