import { describe, expect, it, vi } from "vitest";
import { ELIZA_1_TIER_IDS, findCatalogModel } from "./catalog";
import type { Eliza1Manifest } from "./manifest";
import {
  assessRamFit,
  type ManifestLoader,
  pickFittingContextVariant,
  resolveRamBudget,
} from "./ram-budget";
import type { CatalogModel, InstalledModel } from "./types";

const FIXED_TIME = "2025-01-01T00:00:00.000Z";

function syntheticManifest(overrides: Partial<Eliza1Manifest>): Eliza1Manifest {
  return {
    id: "eliza-1-2b",
    tier: "2b",
    version: "1.0.0",
    publishedAt: FIXED_TIME,
    lineage: {
      text: { base: "eliza-1-2b", license: "apache-2.0" },
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
        rocm: { status: "pass", atCommit: "abc", report: "ok" },
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
    const model = findCatalogModel("eliza-1-2b");
    if (!model) throw new Error("test setup");
    const loader: ManifestLoader = vi.fn(() => syntheticManifest({}));

    const budget = resolveRamBudget(model, installed(model), loader);

    expect(budget.source).toBe("manifest");
    expect(budget.minMb).toBe(5000);
    expect(budget.recommendedMb).toBe(7000);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("falls back to the catalog scalar when an Eliza-1 tier has no manifest on disk", () => {
    const model = findCatalogModel("eliza-1-2b");
    if (!model) throw new Error("test setup");
    const loader: ManifestLoader = vi.fn(() => null);

    const budget = resolveRamBudget(model, installed(model), loader);

    expect(budget.source).toBe("catalog");
    // catalog row says minRamGb: 4 → 4096 MB; recommendedMb adds the
    // bundle's KV-cache footprint at its 32k default ctx (1.7B ≈ 2400
    // B/token → 75 MB), so recommended is the boot floor plus that.
    expect(budget.minMb).toBe(4 * 1024);
    expect(budget.recommendedMb).toBeGreaterThan(budget.minMb);
    expect(budget.recommendedMb).toBe(4 * 1024 + 75);
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
    const model = findCatalogModel("eliza-1-27b");
    if (!model) throw new Error("test setup");
    const loader: ManifestLoader = vi.fn(() => syntheticManifest({}));

    const budget = resolveRamBudget(model, undefined, loader);

    expect(budget.source).toBe("catalog");
    expect(loader).not.toHaveBeenCalled();
  });

  it("ignores a manifest whose tier disagrees with the installed id", () => {
    const model = findCatalogModel("eliza-1-2b");
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

const noopLoader: ManifestLoader = () => null;

describe("assessRamFit", () => {
  const model = findCatalogModel("eliza-1-9b");
  if (!model) throw new Error("test setup: eliza-1-9b missing");
  // 9b: minRamGb 12 → minMb 12288; recommendedMb 12288 + KV(64k @ 9B).

  it("refuses (wontfit) when usable RAM is below the boot floor", () => {
    // 8 GB host, default ~1.5 GB reserve → ~6.5 GB usable << 12 GB floor.
    const d = assessRamFit(model, 8 * 1024, { manifestLoader: noopLoader });
    expect(d.level).toBe("wontfit");
    expect(d.fits).toBe(false);
    expect(d.budget.minMb).toBe(12 * 1024);
  });

  it("reports tight when usable RAM clears the floor but not the recommended", () => {
    const floor = assessRamFit(model, 0, { manifestLoader: noopLoader }).budget;
    expect(floor.recommendedMb).toBeGreaterThan(floor.minMb);
    // Sit exactly between the boot floor and the recommended budget.
    const between = Math.floor((floor.minMb + floor.recommendedMb) / 2);
    const d = assessRamFit(model, between, {
      manifestLoader: noopLoader,
      reserveMb: 0,
    });
    expect(d.level).toBe("tight");
    expect(d.fits).toBe(true);
  });

  it("reports fits with comfortable headroom", () => {
    const d = assessRamFit(model, 64 * 1024, { manifestLoader: noopLoader });
    expect(d.level).toBe("fits");
    expect(d.fits).toBe(true);
  });

  it("honours an explicit reserve override (0 = raw RAM)", () => {
    const tight = assessRamFit(model, 12 * 1024 + 100, {
      manifestLoader: noopLoader,
      reserveMb: 0,
    });
    expect(tight.fits).toBe(true);
    const refused = assessRamFit(model, 12 * 1024 + 100, {
      manifestLoader: noopLoader,
      reserveMb: 4096,
    });
    expect(refused.level).toBe("wontfit");
  });

  it("a manifest-declared budget wins over the catalog scalar", () => {
    const loader: ManifestLoader = () =>
      syntheticManifest({
        id: model.id,
        tier: model.id.slice("eliza-1-".length) as Eliza1Manifest["tier"],
        ramBudgetMb: { min: 99000, recommended: 99000 },
      });
    const d = assessRamFit(model, 64 * 1024, {
      manifestLoader: loader,
      installed: installed(model),
    });
    expect(d.level).toBe("wontfit");
    expect(d.budget.source).toBe("manifest");
    expect(d.budget.minMb).toBe(99000);
  });
});

describe("pickFittingContextVariant", () => {
  it("picks the largest 27B context variant that fits the host", () => {
    const m1 = findCatalogModel("eliza-1-27b-1m");
    if (!m1) throw new Error("test setup");
    // 40 GB host: 27b (32 GB floor) fits, 27b-256k (96 GB) does not,
    // 27b-1m (200 GB) does not. Picking from 27b-1m falls back to 27b.
    const picked = pickFittingContextVariant(m1, 40 * 1024, {
      manifestLoader: noopLoader,
      reserveMb: 1536,
    });
    expect(picked?.id).toBe("eliza-1-27b");
  });

  it("picks the 256k variant when there's enough RAM for it but not 1m", () => {
    const m1 = findCatalogModel("eliza-1-27b-1m");
    if (!m1) throw new Error("test setup");
    const picked = pickFittingContextVariant(m1, 110 * 1024, {
      manifestLoader: noopLoader,
      reserveMb: 1536,
    });
    expect(picked?.id).toBe("eliza-1-27b-256k");
  });

  it("returns the model itself when it already fits", () => {
    const m27 = findCatalogModel("eliza-1-27b");
    if (!m27) throw new Error("test setup");
    const picked = pickFittingContextVariant(m27, 64 * 1024, {
      manifestLoader: noopLoader,
    });
    expect(picked?.id).toBe("eliza-1-27b");
  });

  it("returns null when not even the smallest variant of the line fits", () => {
    const m27 = findCatalogModel("eliza-1-27b");
    if (!m27) throw new Error("test setup");
    const picked = pickFittingContextVariant(m27, 8 * 1024, {
      manifestLoader: noopLoader,
    });
    expect(picked).toBeNull();
  });

  it("does not cross param-count lines (9b never picked from a 27b request)", () => {
    const m27 = findCatalogModel("eliza-1-27b-256k");
    if (!m27) throw new Error("test setup");
    // Enough for 9b (12 GB) but not any 27b variant.
    const picked = pickFittingContextVariant(m27, 14 * 1024, {
      manifestLoader: noopLoader,
      reserveMb: 1536,
    });
    expect(picked).toBeNull();
  });
});
