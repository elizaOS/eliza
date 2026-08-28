/**
 * Contract tests for the Model Hub view-model helpers (hub-utils). Harness is
 * deterministic: pure functions exercised with real inputs at their owning
 * boundary — no DOM, no mocks. computeFit is exercised through the REAL
 * assessCatalogModelFit delegation (desktop branch: assessFit over sizeGb and
 * minRamGb). Backlog for issue #29212.
 */
import { describe, expect, it } from "vitest";
import type {
  CatalogModel,
  DownloadJob,
  HardwareProbe,
  InstalledModel,
  ModelBucket,
} from "../../api/client-local-inference";
import {
  bucketLabel,
  computeFit,
  displayModelName,
  findCatalogModel,
  findDownload,
  findInstalled,
  fitLabel,
  formatBytes,
  formatEta,
  groupByBucket,
  progressPercent,
} from "./hub-utils";

function job(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    jobId: "job-1",
    modelId: "eliza-1-2b",
    state: "downloading",
    received: 0,
    total: 1000,
    bytesPerSec: 0,
    etaMs: null,
    startedAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-26T00:00:00Z",
    ...overrides,
  };
}

function installed(
  id: string,
  path: string,
  overrides: Partial<InstalledModel> = {},
): InstalledModel {
  return {
    id,
    displayName: id,
    path,
    sizeBytes: 1024,
    installedAt: "2026-08-26T00:00:00Z",
    lastUsedAt: null,
    source: "eliza-download",
    ...overrides,
  } satisfies InstalledModel;
}

/** Complete CatalogModel fixture — no `as` casts; satisfies keeps every
 * required field checked so a type change on the contract breaks this suite
 * at compile time instead of silently passing stale shapes. */
function catalogModel(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: "eliza-1-9b",
    displayName: "Eliza 1 9B",
    hfRepo: "elizaos/eliza-1",
    ggufFile: "eliza-1-9b-q4_k_m.gguf",
    params: "9B",
    quant: "q4_k_m",
    sizeGb: 5,
    minRamGb: 8,
    category: "chat",
    bucket: "mid",
    blurb: "fixture",
    ...overrides,
  } satisfies CatalogModel;
}

function desktopProbe(overrides: Partial<HardwareProbe> = {}): HardwareProbe {
  return {
    totalRamGb: 32,
    freeRamGb: 16,
    gpu: null,
    cpuCores: 10,
    platform: "darwin",
    arch: "arm64",
    appleSilicon: false,
    recommendedBucket: "mid",
    source: "os-fallback",
    ...overrides,
  } satisfies HardwareProbe;
}

describe("formatEta — download ETA bucket math", () => {
  it("returns empty string when eta is null, non-finite, or non-positive", () => {
    expect(formatEta(null)).toBe("");
    expect(formatEta(Number.NaN)).toBe("");
    expect(formatEta(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatEta(0)).toBe("");
    expect(formatEta(-5)).toBe("");
  });

  it("renders sub-minute ETAs in seconds using ceil rounding", () => {
    expect(formatEta(1)).toBe("1s");
    expect(formatEta(59_000)).toBe("59s");
    // ceil(59_400/1000) = 60s crosses into the minutes bucket, not "60s".
    expect(formatEta(59_400)).toBe("1m 0s");
    expect(formatEta(0.1)).toBe("1s");
  });

  it("keeps an ETA under one hour in the minutes bucket", () => {
    expect(formatEta(60_000)).toBe("1m 0s");
    expect(formatEta(3_599_000)).toBe("59m 59s");
    // ceil pushes 3_599_999ms to 3600s, which is already the hours bucket.
    expect(formatEta(3_599_999)).toBe("1h 0m");
  });

  it("moves an hour-or-longer ETA into the hours bucket", () => {
    expect(formatEta(3_600_000)).toBe("1h 0m");
    expect(formatEta(7_322_000)).toBe("2h 2m");
  });
});

describe("progressPercent — clamp and guard contract", () => {
  it("returns 0 for a missing job or a non-positive total", () => {
    expect(progressPercent(undefined)).toBe(0);
    expect(progressPercent(job({ total: 0, received: 500 }))).toBe(0);
    expect(progressPercent(job({ total: -10, received: 500 }))).toBe(0);
  });

  it("clamps over-reporting jobs at 100 instead of exceeding the bar", () => {
    expect(progressPercent(job({ received: 1500, total: 1000 }))).toBe(100);
  });

  it("computes rounded percent from received/total", () => {
    expect(progressPercent(job({ received: 250, total: 1000 }))).toBe(25);
    expect(progressPercent(job({ received: 255, total: 1000 }))).toBe(26);
    expect(progressPercent(job({ received: 1000, total: 1000 }))).toBe(100);
  });
});

describe("findInstalled — install detection incl. external basename fallback", () => {
  const model = catalogModel();

  it("prefers an exact id match over the basename fallback", () => {
    const exact = installed("eliza-1-9b", "/models/other.gguf");
    const byBasename = installed(
      "external-hf-abc",
      "/models/eliza-1-9b-q4_k_m.gguf",
    );
    expect(findInstalled(model, [byBasename, exact])).toBe(exact);
  });

  it("matches external installs by POSIX path basename", () => {
    const external = installed(
      "external-hf-abc123",
      "/Users/x/.eliza/models/eliza-1-9b-q4_k_m.gguf",
    );
    expect(findInstalled(model, [external])).toBe(external);
  });

  it("matches external installs by Windows path basename", () => {
    const external = installed(
      "external-hf-abc123",
      "C:\\models\\eliza-1-9b-q4_k_m.gguf",
    );
    expect(findInstalled(model, [external])).toBe(external);
  });

  it("matches case-insensitively across ggufFile and installed path", () => {
    const upperPath = installed(
      "external-hf-upper",
      "/models/ELIZA-1-9B-Q4_K_M.GGUF",
    );
    expect(findInstalled(model, [upperPath])).toBe(upperPath);
    // The other half of the same contract: an uppercase catalog ggufFile
    // against a lowercase installed path. Pin both sides so a regression in
    // either .toLowerCase() branch is caught independently.
    const upperCatalog = { ...model, ggufFile: "ELIZA-1-9B-Q4_K_M.GGUF" };
    const lowerPath = installed(
      "external-hf-lower",
      "/models/eliza-1-9b-q4_k_m.gguf",
    );
    expect(findInstalled(upperCatalog, [lowerPath])).toBe(lowerPath);
  });

  it("ignores files that merely contain the gguf name mid-path", () => {
    const trick = installed(
      "external-hf-xyz",
      "/models/eliza-1-9b-q4_k_m.gguf.bak",
    );
    expect(findInstalled(model, [trick])).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(findInstalled(model, [])).toBeUndefined();
    expect(
      findInstalled(model, [installed("other-1", "/models/a.gguf")]),
    ).toBeUndefined();
  });
});

describe("groupByBucket — section grouping contract", () => {
  it("always returns all four buckets in canonical order, empty ones included", () => {
    const groups = groupByBucket([]);
    expect([...groups.keys()]).toEqual(["small", "mid", "large", "xl"]);
    for (const models of groups.values()) {
      expect(models).toEqual([]);
    }
  });

  it("groups models under their bucket, preserving input order", () => {
    const small1 = catalogModel({ id: "a", bucket: "small" });
    const mid1 = catalogModel({ id: "b", bucket: "mid" });
    const small2 = catalogModel({ id: "c", bucket: "small" });
    const groups = groupByBucket([small1, mid1, small2]);
    expect(groups.get("small")?.map((m) => m.id)).toEqual(["a", "c"]);
    expect(groups.get("mid")?.map((m) => m.id)).toEqual(["b"]);
    expect(groups.get("large")).toEqual([]);
    expect(groups.get("xl")).toEqual([]);
  });
});

describe("displayModelName — curated table, drafter derivation, fallback chain", () => {
  it("prefers the curated table label over a conflicting displayName", () => {
    expect(
      displayModelName({ id: "eliza-1-2b", displayName: "Wrong Label" }),
    ).toBe("eliza-1-2b");
  });

  it("derives the drafter label from the base model id", () => {
    expect(displayModelName({ id: "eliza-1-9b-drafter" })).toBe(
      "eliza-1-9b drafter",
    );
    // A drafter suffix on a NON-curated base is not remapped; the displayName
    // fallback then applies.
    expect(
      displayModelName({ id: "llama-3-drafter", displayName: "Llama Drafter" }),
    ).toBe("Llama Drafter");
    expect(displayModelName({ id: "llama-3-drafter" })).toBe("llama-3-drafter");
  });

  it("falls back to displayName, then the raw id", () => {
    expect(displayModelName({ id: "hf-x", displayName: "Custom Label" })).toBe(
      "Custom Label",
    );
    expect(displayModelName({ id: "hf-x" })).toBe("hf-x");
  });
});

describe("bucketLabel / fitLabel — UI copy for tiers and fit states", () => {
  it("labels every bucket distinctly", () => {
    const labels = (
      ["small", "mid", "large", "xl"] satisfies ModelBucket[]
    ).map(bucketLabel);
    expect(labels).toEqual(["Fast", "Balanced", "High quality", "Premium"]);
    expect(new Set(labels).size).toBe(4);
  });

  it("labels every fit level distinctly", () => {
    expect(fitLabel("fits")).toBe("Runs smoothly");
    expect(fitLabel("tight")).toBe("Slow on your device");
    expect(fitLabel("wontfit")).toBe("Not enough memory");
  });
});

describe("computeFit — hardware fit delegation (desktop assessFit branch)", () => {
  // CPU-only, non-Apple-Silicon desktop: effective memory = totalRamGb * 0.5.
  const probe = desktopProbe({ totalRamGb: 20 }); // effective 10 GB

  it("fits when size and minRam sit comfortably under thresholds", () => {
    // sizeGb 5: 5 <= 10*0.7 → fits.
    expect(computeFit(catalogModel({ sizeGb: 5, minRamGb: 8 }), probe)).toBe(
      "fits",
    );
  });

  it("is tight when size lands between 70% and 90% of effective memory", () => {
    // sizeGb 8: 8 > 10*0.7 but <= 10*0.9 → tight.
    expect(computeFit(catalogModel({ sizeGb: 8, minRamGb: 8 }), probe)).toBe(
      "tight",
    );
  });

  it("wont-fit when size exceeds 90% of effective memory", () => {
    // sizeGb 9.5: 9.5 > 10*0.9 → wontfit.
    expect(computeFit(catalogModel({ sizeGb: 9.5, minRamGb: 8 }), probe)).toBe(
      "wontfit",
    );
  });

  it("wont-fit when minRam alone exceeds effective memory", () => {
    expect(computeFit(catalogModel({ sizeGb: 1, minRamGb: 16 }), probe)).toBe(
      "wontfit",
    );
  });
});

describe("formatBytes — hub byte formatting (shared formatter + dash label)", () => {
  it("renders plain bytes below 1 KiB", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("renders KiB with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("promotes magnitudes that would round across a unit boundary", () => {
    // 1024**2 - 1 bytes would render as the impossible "1024.0 KB"; the
    // shared formatter promotes it to MB instead.
    expect(formatBytes(1024 ** 2 - 1)).toBe("1.0 MB");
  });

  it("renders the dash unknown label for null/negative input", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("findDownload / findCatalogModel — id lookups", () => {
  it("finds the download job for a model id", () => {
    const target = job({ modelId: "eliza-1-4b", jobId: "job-4b" });
    const other = job({ modelId: "eliza-1-2b", jobId: "job-2b" });
    expect(findDownload("eliza-1-4b", [other, target])).toBe(target);
    expect(findDownload("eliza-1-9b", [other, target])).toBeUndefined();
  });

  it("finds catalog entries by id in a caller-supplied catalog and misses cleanly", () => {
    const a = catalogModel({ id: "m-a" });
    const b = catalogModel({ id: "m-b" });
    expect(findCatalogModel("m-b", [a, b])).toBe(b);
    expect(findCatalogModel("m-missing", [a, b])).toBeUndefined();
    expect(findCatalogModel("m-a", [])).toBeUndefined();
  });
});
