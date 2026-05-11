import { describe, expect, it, vi } from "vitest";
import { ELIZA_1_TIER_IDS, findCatalogModel } from "./catalog";
import type { Eliza1Manifest } from "./manifest";
import { type ManifestLoader, resolveRamBudget } from "./ram-budget";
import type { CatalogModel, InstalledModel } from "./types";

const FIXED_TIME = "2025-01-01T00:00:00.000Z";

function syntheticManifest(overrides: Partial<Eliza1Manifest>): Eliza1Manifest {
  return {
    id: "eliza-1-mobile-1_7b",
    tier: "mobile-1_7b",
    version: "1.0.0",
    publishedAt: FIXED_TIME,
    lineage: {
      text: { base: "eliza-1-mobile-1_7b", license: "apache-2.0" },
      voice: { base: "omnivoice", license: "apache-2.0" },
      drafter: { base: "dflash", license: "apache-2.0" },
    },
    files: {
      text: [{ path: "text/x.gguf", sha256: "a".repeat(64), ctx: 32768 }],
      voice: [{ path: "tts/x.gguf", sha256: "b".repeat(64) }],
      asr: [],
      vision: [],
      dflash: [{ path: "dflash/x.gguf", sha256: "c".repeat(64) }],
      cache: [{ path: "cache/x.bin", sha256: "d".repeat(64) }],
    },
    kernels: {
      required: ["turboquant_q4", "qjl", "polarquant", "dflash"],
      optional: [],
      verifiedBackends: {
        metal: { status: "pass", atCommit: "abc", report: "ok" },
        vulkan: { status: "pass", atCommit: "abc", report: "ok" },
        cuda: { status: "pass", atCommit: "abc", report: "ok" },
        cpu: { status: "pass", atCommit: "abc", report: "ok" },
      },
    },
    evals: {
      textEval: { score: 0.9, passed: true },
      voiceRtf: { rtf: 0.5, passed: true },
      e2eLoopOk: true,
      thirtyTurnOk: true,
    },
    ramBudgetMb: { min: 5000, recommended: 7000 },
    defaultEligible: true,
    ...overrides,
  };
}

function installed(model: CatalogModel): InstalledModel {
  return {
    id: model.id,
    displayName: model.displayName,
    path: `/tmp/eliza-models/${model.id}/text/${model.id}-32k.gguf`,
    sizeBytes: 1_000_000,
    installedAt: FIXED_TIME,
    lastUsedAt: null,
    source: "eliza-download",
  };
}

describe("resolveRamBudget", () => {
  it("uses the manifest budget for an installed Eliza-1 tier when the manifest is valid", () => {
    const model = findCatalogModel("eliza-1-mobile-1_7b");
    if (!model) throw new Error("test setup");
    const loader: ManifestLoader = vi.fn(() => syntheticManifest({}));

    const budget = resolveRamBudget(model, installed(model), loader);

    expect(budget.source).toBe("manifest");
    expect(budget.minMb).toBe(5000);
    expect(budget.recommendedMb).toBe(7000);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("falls back to the catalog scalar when an Eliza-1 tier has no manifest on disk", () => {
    const model = findCatalogModel("eliza-1-mobile-1_7b");
    if (!model) throw new Error("test setup");
    const loader: ManifestLoader = vi.fn(() => null);

    const budget = resolveRamBudget(model, installed(model), loader);

    expect(budget.source).toBe("catalog");
    // catalog row says minRamGb: 4 → 4096 MB, recommendedMb mirrors it.
    expect(budget.minMb).toBe(4 * 1024);
    expect(budget.recommendedMb).toBe(4 * 1024);
  });

  it("never consults the loader for a non-Eliza-1 model", () => {
    // Synthesize a non-Eliza catalog row; loader must never run.
    const nonEliza: CatalogModel = {
      id: "external-test-model",
      displayName: "External Test Model",
      hfRepo: "example/external-test-model",
      ggufFile: "external-test-model.Q4_K_M.gguf",
      sizeGb: 18,
      minRamGb: 24,
      role: "TEXT_LARGE",
      contextLength: 32768,
      shortDescription: "test",
    } as unknown as CatalogModel;
    const loader: ManifestLoader = vi.fn(() => syntheticManifest({}));

    const budget = resolveRamBudget(
      nonEliza,
      {
        id: nonEliza.id,
        displayName: nonEliza.displayName,
        path: "/tmp/x.gguf",
        sizeBytes: 1,
        installedAt: FIXED_TIME,
        lastUsedAt: null,
        source: "eliza-download",
      },
      loader,
    );

    expect(budget.source).toBe("catalog");
    expect(budget.minMb).toBe(24 * 1024);
    expect(loader).not.toHaveBeenCalled();
  });

  it("returns the catalog scalar when no installed entry was provided", () => {
    const model = findCatalogModel("eliza-1-pro-27b");
    if (!model) throw new Error("test setup");
    const loader: ManifestLoader = vi.fn(() => syntheticManifest({}));

    const budget = resolveRamBudget(model, undefined, loader);

    expect(budget.source).toBe("catalog");
    expect(loader).not.toHaveBeenCalled();
  });

  it("ignores a manifest whose tier disagrees with the installed id", () => {
    const model = findCatalogModel("eliza-1-mobile-1_7b");
    if (!model) throw new Error("test setup");
    // A loader that returns a manifest for the WRONG tier (e.g. desktop)
    // should be treated the same as no manifest at all.
    const loader: ManifestLoader = () => null;

    const budget = resolveRamBudget(model, installed(model), loader);

    expect(budget.source).toBe("catalog");
  });

  it("covers every Eliza-1 tier with a manifest budget when one is supplied", () => {
    const tiers = ELIZA_1_TIER_IDS.map((id) => {
      const model = findCatalogModel(id);
      if (!model) throw new Error(`missing catalog tier ${id}`);
      return model;
    });
    for (const tier of tiers) {
      const loader: ManifestLoader = () =>
        syntheticManifest({
          id: tier.id,
          tier: tier.id.slice("eliza-1-".length) as Eliza1Manifest["tier"],
          ramBudgetMb: { min: 1234, recommended: 5678 },
        });
      const budget = resolveRamBudget(tier, installed(tier), loader);
      expect(budget.source).toBe("manifest");
      expect(budget.minMb).toBe(1234);
      expect(budget.recommendedMb).toBe(5678);
    }
  });
});
