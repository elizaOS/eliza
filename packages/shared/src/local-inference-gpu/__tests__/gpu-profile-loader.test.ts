/**
 * Host-side unit tests for the GPU profile loader.
 *
 * No GPU is touched: `nvidia-smi` is fully mocked via
 * `__setNvidiaSmiMockForTests`, and we only ever read the bundled YAML
 * files. The task constraint is "no real model loads" — these tests
 * stay strictly at the schema / parsing layer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ELIZA_1_TIER_IDS } from "../../local-inference/catalog.js";
import { getGpuOverrides } from "../gpu-overrides.js";
import {
  __clearProfileCacheForTests,
  __setNvidiaSmiMockForTests,
  classifyGpuName,
  detectGpuFromNvidiaSmi,
  FALLBACK_PROFILE_ID,
  loadProfile,
  profileYamlPath,
  resolveProfileForHost,
} from "../gpu-profile-loader.js";
import {
  bundleIdsInProfileMatchCatalog,
  type GpuYamlId,
} from "../gpu-profile-schema.js";

const ALL_IDS: GpuYamlId[] = ["rtx-3090", "rtx-4090", "rtx-5090", "h200"];

describe("gpu-profile YAML files", () => {
  beforeEach(() => {
    __clearProfileCacheForTests();
    __setNvidiaSmiMockForTests({ kind: "real" });
  });
  afterEach(() => {
    __clearProfileCacheForTests();
    __setNvidiaSmiMockForTests({ kind: "real" });
  });

  it.each(ALL_IDS)("loads %s and matches schema", (id) => {
    const profile = loadProfile(id);
    expect(profile.gpu_id).toBe(id);
    expect(profile.gpu_arch).toMatch(/^sm_\d{2,3}$/);
    expect(profile.vram_gb).toBeGreaterThan(0);
    expect(profile.mem_bandwidth_gbps).toBeGreaterThan(0);
    expect(typeof profile.fp8_supported).toBe("boolean");
    expect(typeof profile.fp4_supported).toBe("boolean");
    expect(profile.verify_recipe.cuda_arch).toBeGreaterThan(0);
    expect(profile.verify_recipe.cmake_flags.length).toBeGreaterThan(0);
    expect(profile.verify_recipe.expected_kernels.length).toBeGreaterThan(0);
    // dflash range is sane
    expect(profile.dflash.draft_min).toBeLessThan(profile.dflash.draft_max);
  });

  it.each(ALL_IDS)("%s recommends only known Eliza-1 tier ids", (id) => {
    const profile = loadProfile(id);
    const check = bundleIdsInProfileMatchCatalog(profile);
    expect(check.unknown).toEqual([]);
    expect(check.ok).toBe(true);
    // At least one bundle is recommended.
    expect(Object.keys(profile.bundle_recommendations).length).toBeGreaterThan(
      0,
    );
  });

  it("3090 lacks FP8, 4090/5090/H200 have it", () => {
    expect(loadProfile("rtx-3090").fp8_supported).toBe(false);
    expect(loadProfile("rtx-4090").fp8_supported).toBe(true);
    expect(loadProfile("rtx-5090").fp8_supported).toBe(true);
    expect(loadProfile("h200").fp8_supported).toBe(true);
    // Only the 5090 has FP4
    expect(loadProfile("rtx-3090").fp4_supported).toBe(false);
    expect(loadProfile("rtx-4090").fp4_supported).toBe(false);
    expect(loadProfile("rtx-5090").fp4_supported).toBe(true);
    expect(loadProfile("h200").fp4_supported).toBe(false);
  });

  it("CUDA arch matches the documented compute capability", () => {
    expect(loadProfile("rtx-3090").verify_recipe.cuda_arch).toBe(86);
    expect(loadProfile("rtx-4090").verify_recipe.cuda_arch).toBe(89);
    expect(loadProfile("rtx-5090").verify_recipe.cuda_arch).toBe(120);
    expect(loadProfile("h200").verify_recipe.cuda_arch).toBe(90);
  });

  it("3090 lists turbo3_tcq as unavailable; 4090/5090/H200 do not", () => {
    expect(loadProfile("rtx-3090").verify_recipe.unavailable_kernels).toContain(
      "turbo3_tcq",
    );
    expect(
      loadProfile("rtx-4090").verify_recipe.unavailable_kernels,
    ).not.toContain("turbo3_tcq");
    expect(
      loadProfile("rtx-5090").verify_recipe.unavailable_kernels,
    ).not.toContain("turbo3_tcq");
    expect(loadProfile("h200").verify_recipe.unavailable_kernels).not.toContain(
      "turbo3_tcq",
    );
  });

  it("H200 is the only profile that includes the 27b-1m bundle", () => {
    const h200 = loadProfile("h200");
    expect(h200.bundle_recommendations["eliza-1-27b-1m"]).toBeDefined();
    for (const id of ["rtx-3090", "rtx-4090", "rtx-5090"] as const) {
      const p = loadProfile(id);
      expect(p.bundle_recommendations["eliza-1-27b-1m"]).toBeUndefined();
    }
  });

  it("YAML files exist at the expected paths", () => {
    for (const id of ALL_IDS) {
      const path = profileYamlPath(id);
      expect(path).toContain(id);
      expect(path.endsWith(".yaml")).toBe(true);
    }
  });

  it("caches loaded profiles", () => {
    const a = loadProfile("rtx-4090");
    const b = loadProfile("rtx-4090");
    expect(a).toBe(b);
  });
});

describe("classifyGpuName", () => {
  it("recognizes common nvidia-smi name formats", () => {
    expect(classifyGpuName("NVIDIA GeForce RTX 3090")).toBe("rtx-3090");
    expect(classifyGpuName("NVIDIA GeForce RTX 4090")).toBe("rtx-4090");
    expect(classifyGpuName("NVIDIA GeForce RTX 5090")).toBe("rtx-5090");
    expect(classifyGpuName("NVIDIA H200")).toBe("h200");
    expect(classifyGpuName("NVIDIA H200 SXM5 141GB")).toBe("h200");
  });

  it("tolerates the no-space spelling", () => {
    expect(classifyGpuName("RTX4090")).toBe("rtx-4090");
    expect(classifyGpuName("RTX3090")).toBe("rtx-3090");
  });

  it("returns null for unsupported GPUs (no silent misclassification)", () => {
    expect(classifyGpuName("NVIDIA GeForce RTX 3080")).toBeNull();
    expect(classifyGpuName("NVIDIA GeForce RTX 4080 SUPER")).toBeNull();
    expect(classifyGpuName("NVIDIA A100-SXM4-80GB")).toBeNull();
    expect(classifyGpuName("NVIDIA H100 SXM5 80GB")).toBeNull();
    expect(classifyGpuName("AMD Radeon RX 7900 XTX")).toBeNull();
    expect(classifyGpuName("")).toBeNull();
  });
});

describe("detectGpuFromNvidiaSmi mock", () => {
  beforeEach(() => __setNvidiaSmiMockForTests({ kind: "real" }));
  afterEach(() => __setNvidiaSmiMockForTests({ kind: "real" }));

  it("returns the mocked name", () => {
    __setNvidiaSmiMockForTests({
      kind: "name",
      value: "NVIDIA GeForce RTX 4090",
    });
    expect(detectGpuFromNvidiaSmi()).toBe("NVIDIA GeForce RTX 4090");
  });

  it("returns null when nvidia-smi is mocked missing", () => {
    __setNvidiaSmiMockForTests({ kind: "missing" });
    expect(detectGpuFromNvidiaSmi()).toBeNull();
  });

  it("takes the first GPU when nvidia-smi returns multiple lines", () => {
    __setNvidiaSmiMockForTests({
      kind: "name",
      // simulate a real multi-GPU host — single-GPU framing picks the first.
      value: "NVIDIA H200\nNVIDIA H200\n",
    });
    expect(detectGpuFromNvidiaSmi()).toBe("NVIDIA H200");
  });
});

describe("resolveProfileForHost", () => {
  beforeEach(() => {
    __clearProfileCacheForTests();
    __setNvidiaSmiMockForTests({ kind: "real" });
  });
  afterEach(() => {
    __setNvidiaSmiMockForTests({ kind: "real" });
  });

  it("returns ok=true for a supported GPU", () => {
    __setNvidiaSmiMockForTests({
      kind: "name",
      value: "NVIDIA GeForce RTX 4090",
    });
    const result = resolveProfileForHost();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.gpuId).toBe("rtx-4090");
      expect(result.detectedName).toBe("NVIDIA GeForce RTX 4090");
    }
  });

  it("returns reason=no-nvidia-gpu when nvidia-smi is missing", () => {
    __setNvidiaSmiMockForTests({ kind: "missing" });
    const result = resolveProfileForHost();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("no-nvidia-gpu");
    expect(result.ok === false && result.detectedName).toBeNull();
  });

  it("returns reason=unsupported-gpu for an unrecognized card", () => {
    __setNvidiaSmiMockForTests({
      kind: "name",
      value: "NVIDIA GeForce RTX 3080",
    });
    const result = resolveProfileForHost();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unsupported-gpu");
    expect(result.ok === false && result.detectedName).toBe(
      "NVIDIA GeForce RTX 3080",
    );
  });

  it("FALLBACK_PROFILE_ID is the most conservative supported card", () => {
    expect(FALLBACK_PROFILE_ID).toBe("rtx-3090");
  });
});

describe("getGpuOverrides", () => {
  it("returns 'applied' for a bundle the profile knows about", () => {
    const profile = loadProfile("rtx-4090");
    const result = getGpuOverrides({ profile, bundleId: "eliza-1-9b" });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      // ctx_size from the 4090 YAML for 9B is 131072.
      expect(result.overrides.contextSize).toBe(131072);
      expect(result.overrides.cacheTypeK).toBe("qjl1_256");
      expect(result.overrides.cacheTypeV).toBe("q4_polar");
      expect(result.overrides.nGpuLayers).toBe(-1);
      expect(result.overrides.flashAttention).toBe(true);
      // DFlash propagation
      expect(result.overrides.draftMin).toBe(4);
      expect(result.overrides.draftMax).toBe(24);
      expect(result.gpuId).toBe("rtx-4090");
    }
  });

  it("returns 'no-recommendation' when the bundle is missing from the profile", () => {
    // 3090 yaml has no 27b-1m entry.
    const profile = loadProfile("rtx-3090");
    const result = getGpuOverrides({ profile, bundleId: "eliza-1-27b-1m" });
    expect(result.kind).toBe("no-recommendation");
  });

  it("H200 applies the 1M-context override for eliza-1-27b-1m", () => {
    const profile = loadProfile("h200");
    const result = getGpuOverrides({ profile, bundleId: "eliza-1-27b-1m" });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.overrides.contextSize).toBe(1048576);
      expect(result.overrides.nGpuLayers).toBe(-1);
    }
  });

  it("3090 uses partial offload (n_gpu_layers > 0) for 27B", () => {
    const profile = loadProfile("rtx-3090");
    const result = getGpuOverrides({ profile, bundleId: "eliza-1-27b" });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.overrides.nGpuLayers).toBeGreaterThan(0);
      expect(result.overrides.nGpuLayers).toBeLessThan(80);
    }
  });
});

describe("catalog cross-references", () => {
  it("ELIZA_1_TIER_IDS still includes the bundles the profiles target", () => {
    const all = new Set<string>(ELIZA_1_TIER_IDS);
    for (const id of ALL_IDS) {
      const p = loadProfile(id);
      for (const bid of Object.keys(p.bundle_recommendations)) {
        expect(all.has(bid)).toBe(true);
      }
    }
  });
});
