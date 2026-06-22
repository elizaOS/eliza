import { describe, expect, it } from "vitest";

import { findCatalogModel, MODEL_CATALOG } from "./catalog.js";
import {
  classifyCatalogModelRuntimeClass,
  classifyInstalledModelRuntimeClass,
  withRuntimeClass,
} from "./runtime-class.js";
import type { InstalledModel } from "./types.js";

describe("classifyCatalogModelRuntimeClass", () => {
  it("classes every curated Eliza-1 tier as fused-eliza1", () => {
    for (const model of MODEL_CATALOG) {
      expect(classifyCatalogModelRuntimeClass(model)).toBe("fused-eliza1");
      // The catalog factory also populates the field directly.
      expect(model.runtimeClass).toBe("fused-eliza1");
    }
  });

  it("classes a synthetic Hugging Face GGUF result as generic-gguf", () => {
    expect(
      classifyCatalogModelRuntimeClass({
        id: "hf:meta-llama/Llama-3.2-3B-Instruct-GGUF::Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        bundleManifestFile: undefined,
        runtimeRole: undefined,
      }),
    ).toBe("generic-gguf");
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

  it("classes a single downloaded GGUF (no bundleRoot) as generic-gguf", () => {
    expect(
      classifyInstalledModelRuntimeClass(
        installed({
          id: "hf:org/model::model.Q4_K_M.gguf",
          source: "external-scan",
          externalOrigin: "lm-studio",
        }),
      ),
    ).toBe("generic-gguf");
  });

  it("trusts an explicit runtimeClass field verbatim", () => {
    expect(
      classifyInstalledModelRuntimeClass(
        installed({ id: "eliza-1-4b", runtimeClass: "generic-gguf" }),
      ),
    ).toBe("generic-gguf");
  });
});

describe("withRuntimeClass backfill", () => {
  it("backfills a legacy row that has no runtimeClass", () => {
    const row = installed({ id: "some-gguf" });
    expect(row.runtimeClass).toBeUndefined();
    expect(withRuntimeClass(row).runtimeClass).toBe("generic-gguf");
  });

  it("returns the same reference when the field is already present", () => {
    const row = installed({ id: "eliza-1-4b", runtimeClass: "fused-eliza1" });
    expect(withRuntimeClass(row)).toBe(row);
  });
});
