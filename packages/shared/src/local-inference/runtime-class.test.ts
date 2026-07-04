/**
 * Covers the runtime-class helpers for the Eliza-1-only local stack:
 * classifyCatalogModelRuntimeClass / classifyInstalledModelRuntimeClass both
 * always return "fused-eliza1" (the generic-GGUF path was removed in #8808), and
 * withRuntimeClass backfills that field on legacy rows while returning the same
 * reference when it is already set. Pure Vitest over MODEL_CATALOG plus
 * synthetic InstalledModel rows.
 */
import { describe, expect, it } from "vitest";

import { MODEL_CATALOG } from "./catalog.js";
import {
  classifyCatalogModelRuntimeClass,
  classifyInstalledModelRuntimeClass,
  withRuntimeClass,
} from "./runtime-class.js";
import type { InstalledModel } from "./types.js";

// Eliza-1-only stack: the local runtime serves exactly the curated Eliza-1
// (Gemma 4) tiers through the fused libelizainference. There is no generic-GGUF
// path (removed in the #8808 cutover), so every model classifies as
// "fused-eliza1".

describe("classifyCatalogModelRuntimeClass", () => {
  it("classes every curated Eliza-1 tier as fused-eliza1", () => {
    for (const model of MODEL_CATALOG) {
      expect(classifyCatalogModelRuntimeClass(model)).toBe("fused-eliza1");
      // The catalog factory also populates the field directly.
      expect(model.runtimeClass).toBe("fused-eliza1");
    }
  });

  it("classes any model as fused-eliza1 (no generic-gguf path)", () => {
    expect(
      classifyCatalogModelRuntimeClass({
        id: "anything",
        bundleManifestFile: undefined,
        runtimeRole: undefined,
      }),
    ).toBe("fused-eliza1");
  });
});

function installed(overrides: Partial<InstalledModel>): InstalledModel {
  return {
    id: "x",
    displayName: "x",
    path: "/tmp/x.gguf",
    sizeBytes: 1,
    installedAt: "2026-06-21T00:00:00.000Z",
    lastUsedAt: null,
    source: "eliza-download",
    ...overrides,
  };
}

describe("classifyInstalledModelRuntimeClass", () => {
  it("classes an Eliza-1 bundle (bundleRoot + tier id) as fused-eliza1", () => {
    expect(
      classifyInstalledModelRuntimeClass(
        installed({ id: "eliza-1-4b", bundleRoot: "/models/eliza-1-4b" }),
      ),
    ).toBe("fused-eliza1");
  });

  it("classes any installed model as fused-eliza1", () => {
    expect(
      classifyInstalledModelRuntimeClass(installed({ id: "some-gguf" })),
    ).toBe("fused-eliza1");
  });
});

describe("withRuntimeClass backfill", () => {
  it("backfills a legacy row to fused-eliza1", () => {
    const row = installed({ id: "some-gguf" });
    expect(row.runtimeClass).toBeUndefined();
    expect(withRuntimeClass(row).runtimeClass).toBe("fused-eliza1");
  });

  it("returns the same reference when the field is already present", () => {
    const row = installed({ id: "eliza-1-4b", runtimeClass: "fused-eliza1" });
    expect(withRuntimeClass(row)).toBe(row);
  });
});
