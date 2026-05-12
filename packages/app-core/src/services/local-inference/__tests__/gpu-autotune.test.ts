import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  FALLBACK_BUCKETS,
  type GpuInfo,
  GPU_CONFIGS,
  flagsToLlamaServerArgv,
  pickFallbackBucket,
  selectGpuConfig,
  staticProfileFor,
} from "../gpu-autotune";

const fileDir = path.dirname(fileURLToPath(import.meta.url));
// __tests__/ -> local-inference/ -> services/ -> src/ -> app-core/ -> packages/
const monorepoRoot = path.resolve(fileDir, "../../../../../..");
const configsDir = path.join(
  monorepoRoot,
  "packages/inference/configs/gpu",
);

const ALL_IDS = ["rtx-3090", "rtx-4090", "rtx-5090", "h200"] as const;

describe("GPU autotune — config table", () => {
  it("exposes one config per supported GPU id", () => {
    for (const id of ALL_IDS) {
      expect(GPU_CONFIGS[id]).toBeDefined();
      expect(GPU_CONFIGS[id].id).toBe(id);
    }
  });

  it("every config marks expected_metrics as extrapolated until measured", () => {
    for (const id of ALL_IDS) {
      expect(GPU_CONFIGS[id].expected_metrics._provenance).toBe(
        "extrapolated",
      );
    }
  });

  it("inlined GPU_CONFIGS matches the per-GPU JSON files on disk", () => {
    const filenameById: Record<string, string> = {
      "rtx-3090": "3090.json",
      "rtx-4090": "4090.json",
      "rtx-5090": "5090.json",
      h200: "h200.json",
    };
    for (const id of ALL_IDS) {
      const onDisk = JSON.parse(
        readFileSync(path.join(configsDir, filenameById[id]), "utf8"),
      );
      const inMemory = GPU_CONFIGS[id];
      // Spot-check the keys that have to stay in sync.
      expect(onDisk.id).toBe(inMemory.id);
      expect(onDisk.vram_gb).toBe(inMemory.vram_gb);
      expect(onDisk.compute_capability).toBe(inMemory.compute_capability);
      expect(onDisk.memory_bandwidth_gbs).toBe(inMemory.memory_bandwidth_gbs);
      expect(onDisk.fp8).toBe(inMemory.fp8);
      expect(onDisk.flash_attn_3).toBe(inMemory.flash_attn_3);
      expect(onDisk.llama_server_flags.n_parallel).toBe(
        inMemory.llama_server_flags.n_parallel,
      );
      expect(onDisk.llama_server_flags.cache_type_k).toBe(
        inMemory.llama_server_flags.cache_type_k,
      );
      expect(onDisk.llama_server_flags.ubatch_size).toBe(
        inMemory.llama_server_flags.ubatch_size,
      );
      expect(onDisk.expected_metrics._provenance).toBe("extrapolated");
    }
  });

  it("static profile lookup matches the GpuProfileId", () => {
    expect(staticProfileFor(GPU_CONFIGS["rtx-3090"]).id).toBe("rtx-3090");
    expect(staticProfileFor(GPU_CONFIGS.h200).id).toBe("h200");
  });
});

describe("GPU autotune — per-GPU invariants", () => {
  it("3090 has FP8 / FP4 / flash-attn-3 disabled", () => {
    const c = GPU_CONFIGS["rtx-3090"];
    expect(c.fp8).toBe(false);
    expect(c.fp4).toBe(false);
    expect(c.flash_attn_3).toBe(false);
    expect(c.compute_capability).toBe("8.6");
    expect(c.arch).toBe("ampere");
  });

  it("4090 enables FP8 but not FP4 / flash-attn-3", () => {
    const c = GPU_CONFIGS["rtx-4090"];
    expect(c.fp8).toBe(true);
    expect(c.fp4).toBe(false);
    expect(c.flash_attn_3).toBe(false);
    expect(c.compute_capability).toBe("8.9");
    expect(c.arch).toBe("ada-lovelace");
  });

  it("5090 enables FP8 + FP4 + flash-attn-3", () => {
    const c = GPU_CONFIGS["rtx-5090"];
    expect(c.fp8).toBe(true);
    expect(c.fp4).toBe(true);
    expect(c.flash_attn_3).toBe(true);
    expect(c.arch).toBe("blackwell");
    expect(c.vram_gb).toBe(32);
  });

  it("H200 enables FP8 + flash-attn-3 but not FP4 (Hopper)", () => {
    const c = GPU_CONFIGS.h200;
    expect(c.fp8).toBe(true);
    expect(c.fp4).toBe(false);
    expect(c.flash_attn_3).toBe(true);
    expect(c.arch).toBe("hopper");
    expect(c.vram_gb).toBeGreaterThanOrEqual(140);
  });

  it("parallel monotonically scales with mem-bw (small-bw -> large-bw)", () => {
    expect(GPU_CONFIGS["rtx-3090"].llama_server_flags.n_parallel).toBeLessThan(
      GPU_CONFIGS["rtx-4090"].llama_server_flags.n_parallel,
    );
    expect(GPU_CONFIGS["rtx-4090"].llama_server_flags.n_parallel).toBeLessThan(
      GPU_CONFIGS["rtx-5090"].llama_server_flags.n_parallel,
    );
    expect(GPU_CONFIGS["rtx-5090"].llama_server_flags.n_parallel).toBeLessThan(
      GPU_CONFIGS.h200.llama_server_flags.n_parallel,
    );
  });

  it("expected RTF improves as the card scales up", () => {
    expect(GPU_CONFIGS["rtx-3090"].expected_metrics.rtf).toBeGreaterThan(
      GPU_CONFIGS["rtx-4090"].expected_metrics.rtf,
    );
    expect(GPU_CONFIGS["rtx-4090"].expected_metrics.rtf).toBeGreaterThan(
      GPU_CONFIGS["rtx-5090"].expected_metrics.rtf,
    );
    expect(GPU_CONFIGS["rtx-5090"].expected_metrics.rtf).toBeGreaterThan(
      GPU_CONFIGS.h200.expected_metrics.rtf,
    );
  });
});

describe("selectGpuConfig — exact-name matches", () => {
  function info(name: string, totalMemoryMiB: number): GpuInfo {
    return { name, totalMemoryMiB };
  }

  it("matches RTX 3090", () => {
    const res = selectGpuConfig(info("NVIDIA GeForce RTX 3090", 24576));
    expect(res?.source).toBe("match");
    expect(res?.config.id).toBe("rtx-3090");
  });

  it("matches RTX 4090", () => {
    const res = selectGpuConfig(info("NVIDIA GeForce RTX 4090", 24576));
    expect(res?.source).toBe("match");
    expect(res?.config.id).toBe("rtx-4090");
  });

  it("matches RTX 5090", () => {
    const res = selectGpuConfig(info("NVIDIA GeForce RTX 5090", 32768));
    expect(res?.source).toBe("match");
    expect(res?.config.id).toBe("rtx-5090");
  });

  it("matches H200", () => {
    const res = selectGpuConfig(info("NVIDIA H200", 141248));
    expect(res?.source).toBe("match");
    expect(res?.config.id).toBe("h200");
  });

  it("returns null for non-NVIDIA + tiny VRAM", () => {
    const res = selectGpuConfig(info("AMD Radeon RX 580", 8192));
    expect(res).toBeNull();
  });
});

describe("selectGpuConfig — bundle-aware overrides", () => {
  function info(name: string, totalMemoryMiB: number): GpuInfo {
    return { name, totalMemoryMiB };
  }

  it("4090 + eliza-1-2b -> 16 parallel @ 64k", () => {
    const res = selectGpuConfig(info("NVIDIA GeForce RTX 4090", 24576), {
      bundleId: "eliza-1-2b",
    });
    expect(res?.flags.n_parallel).toBe(16);
    expect(res?.flags.ctx_size).toBe(65536);
  });

  it("4090 + eliza-1-27b -> 2 parallel @ 32k", () => {
    const res = selectGpuConfig(info("NVIDIA GeForce RTX 4090", 24576), {
      bundleId: "eliza-1-27b",
    });
    expect(res?.flags.n_parallel).toBe(2);
    expect(res?.flags.ctx_size).toBe(32768);
  });

  it("H200 + eliza-1-27b-1m -> 2 parallel @ 1M", () => {
    const res = selectGpuConfig(info("NVIDIA H200", 141248), {
      bundleId: "eliza-1-27b-1m",
    });
    expect(res?.flags.n_parallel).toBe(2);
    expect(res?.flags.ctx_size).toBe(1_048_576);
  });

  it("voice bundle narrows batch / ubatch on every card", () => {
    for (const name of [
      "NVIDIA GeForce RTX 3090",
      "NVIDIA GeForce RTX 4090",
      "NVIDIA GeForce RTX 5090",
      "NVIDIA H200",
    ]) {
      const res = selectGpuConfig(info(name, 24576), { bundleId: "voice" });
      expect(res).not.toBeNull();
      // Every voice override sets a smaller ctx than the default.
      expect(res!.flags.ctx_size).toBeLessThanOrEqual(16384);
    }
  });

  it("3090 + eliza-1-2b overrides cache_type_v to q4_0 (no Polar on sm_86)", () => {
    const res = selectGpuConfig(info("NVIDIA GeForce RTX 3090", 24576), {
      bundleId: "eliza-1-2b",
    });
    expect(res?.flags.cache_type_v).toBe("q4_0");
  });

  it("5090 + eliza-1-27b-256k opts into kvSpillToCpu", () => {
    const res = selectGpuConfig(info("NVIDIA GeForce RTX 5090", 32768), {
      bundleId: "eliza-1-27b-256k",
    });
    expect(res?.flags.no_kv_offload).toBe(true);
  });

  it("per-call overrides take precedence over bundle overrides", () => {
    const res = selectGpuConfig(info("NVIDIA GeForce RTX 4090", 24576), {
      bundleId: "eliza-1-2b",
      overrides: { n_parallel: 4, ctx_size: 8192 },
    });
    expect(res?.flags.n_parallel).toBe(4);
    expect(res?.flags.ctx_size).toBe(8192);
  });
});

describe("VRAM-bucket fallback", () => {
  function info(name: string, totalMemoryMiB: number): GpuInfo {
    return { name, totalMemoryMiB };
  }

  it("picks 'tiny' (null config) for under-12 GiB cards", () => {
    const bucket = pickFallbackBucket(8);
    expect(bucket?.label).toBe("tiny");
    expect(bucket?.config_id).toBeNull();
  });

  it("returns null when GPU name does not match and VRAM is tiny", () => {
    const res = selectGpuConfig(info("Tesla T4", 16384));
    // T4 has 16 GiB — falls into "small" bucket -> rtx-3090.
    expect(res?.source).toBe("bucket");
    expect(res?.bucketLabel).toBe("small");
    expect(res?.config.id).toBe("rtx-3090");
  });

  it("unknown 24 GiB card -> rtx-3090 'mid' bucket", () => {
    const res = selectGpuConfig(info("AMD Radeon RX 7900 XTX", 24576));
    expect(res?.source).toBe("bucket");
    expect(res?.bucketLabel).toBe("mid");
    expect(res?.config.id).toBe("rtx-3090");
  });

  it("unknown 80 GiB card -> rtx-5090 'large' bucket", () => {
    const res = selectGpuConfig(info("NVIDIA A100 80GB", 81920));
    expect(res?.source).toBe("bucket");
    expect(res?.bucketLabel).toBe("large");
    expect(res?.config.id).toBe("rtx-5090");
  });

  it("unknown 100+ GiB card -> h200 'huge' bucket", () => {
    const res = selectGpuConfig(info("NVIDIA B200", 192 * 1024));
    expect(res?.source).toBe("bucket");
    expect(res?.bucketLabel).toBe("huge");
    expect(res?.config.id).toBe("h200");
  });

  it("parallel_scale halves the bucket's n_parallel when set", () => {
    // mid-plus bucket (36 GiB) -> rtx-5090 with 0.5 parallel scaling.
    const res = selectGpuConfig(info("NVIDIA L40S", 36 * 1024));
    expect(res?.source).toBe("bucket");
    expect(res?.bucketLabel).toBe("mid-plus");
    // 5090 default parallel = 12; scaled by 0.5 = 6.
    expect(res?.flags.n_parallel).toBe(6);
  });

  it("returns null when nothing matches AND VRAM is below tiny threshold", () => {
    const res = selectGpuConfig(info("Intel HD 4000", 1024));
    expect(res).toBeNull();
  });

  it("fallback buckets are sorted ascending by max_vram_gb", () => {
    for (let i = 1; i < FALLBACK_BUCKETS.length; i++) {
      expect(FALLBACK_BUCKETS[i].max_vram_gb).toBeGreaterThan(
        FALLBACK_BUCKETS[i - 1].max_vram_gb,
      );
    }
  });
});

describe("flagsToLlamaServerArgv", () => {
  it("emits canonical llama-server flag names", () => {
    const res = selectGpuConfig({
      name: "NVIDIA GeForce RTX 4090",
      totalMemoryMiB: 24576,
    });
    expect(res).not.toBeNull();
    const argv = flagsToLlamaServerArgv(res!.flags);
    expect(argv).toContain("--n-gpu-layers");
    expect(argv).toContain("--ctx-size");
    expect(argv).toContain("--batch-size");
    expect(argv).toContain("--ubatch-size");
    expect(argv).toContain("--parallel");
    expect(argv).toContain("--cache-type-k");
    expect(argv).toContain("--cache-type-v");
    expect(argv).toContain("--split-mode");
    expect(argv).toContain("--main-gpu");
    expect(argv).toContain("--draft-min");
    expect(argv).toContain("--draft-max");
    expect(argv).toContain("--ctx-checkpoints");
    expect(argv).toContain("--ctx-checkpoint-interval");
    expect(argv).toContain("-fa");
  });

  it("only emits --mlock when mlock is true", () => {
    const argv = flagsToLlamaServerArgv({
      n_gpu_layers: 999,
      ctx_size: 8192,
      batch_size: 1024,
      ubatch_size: 256,
      n_parallel: 1,
      cache_type_k: "q8_0",
      cache_type_v: "q8_0",
      flash_attn: false,
      split_mode: "none",
      main_gpu: 0,
      mlock: false,
      no_mmap: false,
      no_kv_offload: false,
      ctx_checkpoints: 0,
      ctx_checkpoint_interval: 1,
      draft_max: 4,
      draft_min: 2,
      draft_p_min: 0.5,
    });
    expect(argv).not.toContain("--mlock");
    expect(argv).not.toContain("--no-mmap");
    expect(argv).not.toContain("--no-kv-offload");
    expect(argv).not.toContain("-fa");
  });
});

describe("JSON file schema validity", () => {
  it("every per-GPU JSON parses and has the required top-level keys", () => {
    const filenameById: Record<string, string> = {
      "rtx-3090": "3090.json",
      "rtx-4090": "4090.json",
      "rtx-5090": "5090.json",
      h200: "h200.json",
    };
    for (const id of ALL_IDS) {
      const j = JSON.parse(
        readFileSync(path.join(configsDir, filenameById[id]), "utf8"),
      );
      expect(typeof j.id).toBe("string");
      expect(typeof j.name).toBe("string");
      expect(typeof j.vram_gb).toBe("number");
      expect(typeof j.memory_bandwidth_gbs).toBe("number");
      expect(typeof j.fp8).toBe("boolean");
      expect(typeof j.llama_server_flags).toBe("object");
      expect(typeof j.bundle_recommendations).toBe("object");
      expect(typeof j.expected_metrics).toBe("object");
      expect(["measured", "extrapolated"]).toContain(
        j.expected_metrics._provenance,
      );
    }
  });

  it("schema file is valid JSON", () => {
    const schema = JSON.parse(
      readFileSync(
        path.join(configsDir, "gpu-config.schema.json"),
        "utf8",
      ),
    );
    expect(schema.$schema).toBeDefined();
    expect(schema.type).toBe("object");
  });

  it("index.json lists every config", () => {
    const idx = JSON.parse(
      readFileSync(path.join(configsDir, "index.json"), "utf8"),
    );
    expect(idx.configs.map((c: { id: string }) => c.id).sort()).toEqual([
      "h200",
      "rtx-3090",
      "rtx-4090",
      "rtx-5090",
    ]);
  });
});
