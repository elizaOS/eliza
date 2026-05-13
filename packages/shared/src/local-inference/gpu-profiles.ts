/**
 * Per-GPU deployment profiles for single-GPU Eliza-1 servers.
 *
 * Scope: ONE GPU per host. We do not target NVLink, tensor-parallel splits,
 * or multi-tenant datacenter workloads. The product target is "one
 * conversation at a time on a single GPU box" — `--parallel N` can still go
 * higher than on a phone, but the model is not split across cards.
 *
 * These profiles are *recommendations* — the runtime selects a bundle by id
 * and then maps the host's GPU to a `GpuProfile` to fill in llama-server
 * flags (KV cache types, n-gpu-layers, batch sizing, DFlash draft range,
 * mlock). A non-NVIDIA host returns `null` and the runtime falls back to
 * the catalog defaults.
 *
 * The KV cache type names match `LocalRuntimeKernel` / the llama.cpp fork
 * kernel handles (`qjl1_256`, `q4_polar`, `turbo3_0`, `turbo4_0`, `q8_0`,
 * `f16`) so that `appendOptimizationFlags` + `applyGpuProfile` can pass
 * them straight through to `--cache-type-k` / `--cache-type-v`.
 *
 * The H200 profile is the marquee config: Eliza-1 27B at 1M context with
 * QJL + Polar KV quant. Smaller cards step down both context and bundle
 * size.
 */

import type { Eliza1TierId } from "./catalog.js";

export type GpuProfileId = "rtx-3090" | "rtx-4090" | "rtx-5090" | "h200";

/**
 * KV cache type names accepted by `llama-server --cache-type-k/-v`. Mirrors
 * the strings the buun-llama-cpp fork advertises in `CAPABILITIES.json`.
 * Kept as a string literal union so a profile's choice is checked at
 * compile time and propagates into the bundle manifest's `requiresKernel`
 * set.
 */
export type KvCacheType =
  | "f16"
  | "q8_0"
  | "q4_0"
  | "qjl1_256"
  | "q4_polar"
  | "turbo3_0"
  | "turbo4_0";

export interface GpuProfile {
  id: GpuProfileId;
  /** Human-readable vendor card name shown to the operator. */
  displayName: string;
  /** Total VRAM in GiB. Used for headroom math + recommendations. */
  vramGb: number;
  /** CUDA compute capability, e.g. `"sm_86"`. */
  computeCapability: string;
  /** Peak HBM/GDDR bandwidth in GB/s — feeds the perf estimator. */
  memoryBandwidthGBs: number;
  /** Whether the GPU has hardware FP8 (Ada/Hopper/Blackwell). */
  fp8: boolean;

  /**
   * Recommended catalog bundle ids for single-GPU deployment on this card.
   * Ordered by quality: first entry is the "best fit" for the card; later
   * entries are smaller fallbacks that still leave headroom. The recommender
   * picks the first id that the user has installed.
   */
  recommendedBundles: ReadonlyArray<Eliza1TierId>;

  /** Inference flags. */
  flashAttn: boolean;
  /** `--cache-type-k` value. */
  kvCacheTypeK: KvCacheType;
  /** `--cache-type-v` value. */
  kvCacheTypeV: KvCacheType;
  /**
   * `--n-gpu-layers` — `-1` for "all layers on GPU". Single-GPU only; we
   * never split layers across two cards.
   */
  nGpuLayers: number;
  /**
   * `--ctx-size`. Always sized to the bundle's `contextLength`, but the
   * profile records the *recommended* max for the card.
   */
  contextSize: number;
  /** `--parallel N` continuous-batching slots. */
  parallel: number;
  /** `--batch-size N` logical batch. */
  batchSize: number;
  /** `--ubatch-size N` physical micro-batch. */
  ubatchSize: number;

  /** DFlash speculative-decoding draft range. */
  dflashDraftMin: number;
  dflashDraftMax: number;

  /** `--mlock` — pin model pages in RAM. */
  mlock: boolean;
  /** `--no-mmap` — disable mmap loading. */
  noMmap: boolean;
  /**
   * Force KV spill to CPU (`--no-kv-offload`). Only useful on cards that
   * cannot hold the full KV cache. The 141 GiB H200 sets this to `false`;
   * the 24 GiB cards can opt in for very long contexts.
   */
  kvSpillToCpu: boolean;
}

/**
 * RTX 3090 — Ampere, 24 GiB, no FP8.
 *
 * Best current release fit: Eliza-1 4B at 64k context. Larger 9B/27B
 * hardware-tier plans are hidden until final Eliza-1 weights and evidence
 * exist. Flash-attn helps Ampere meaningfully (sm_86 has the
 * fused-attention kernels).
 */
const RTX_3090: GpuProfile = {
  id: "rtx-3090",
  displayName: "NVIDIA GeForce RTX 3090",
  vramGb: 24,
  computeCapability: "sm_86",
  memoryBandwidthGBs: 936,
  fp8: false,
  recommendedBundles: ["eliza-1-4b", "eliza-1-2b", "eliza-1-0_8b"],
  flashAttn: true,
  // Ampere doesn't have the q4_polar kernel on the Polar fork; fall back to
  // the Q8/Q4 KV quants which work on every sm_70+ GPU.
  kvCacheTypeK: "q8_0",
  kvCacheTypeV: "q4_polar",
  nGpuLayers: -1,
  contextSize: 65536,
  parallel: 4,
  batchSize: 2048,
  ubatchSize: 512,
  dflashDraftMin: 4,
  dflashDraftMax: 16,
  mlock: true,
  noMmap: false,
  kvSpillToCpu: false,
};

/**
 * RTX 4090 — Ada Lovelace, 24 GiB, FP8 (no flash-attn-FP8 yet).
 *
 * Best current release fit: Eliza-1 4B at 64k. The older 9B/27B planning
 * entries are intentionally not recommended until those tiers have final
 * weights and release evidence.
 */
const RTX_4090: GpuProfile = {
  id: "rtx-4090",
  displayName: "NVIDIA GeForce RTX 4090",
  vramGb: 24,
  computeCapability: "sm_89",
  memoryBandwidthGBs: 1008,
  fp8: true,
  recommendedBundles: ["eliza-1-4b", "eliza-1-2b", "eliza-1-0_8b"],
  flashAttn: true,
  kvCacheTypeK: "qjl1_256",
  kvCacheTypeV: "q4_polar",
  nGpuLayers: -1,
  contextSize: 131072,
  parallel: 4,
  batchSize: 2048,
  ubatchSize: 512,
  dflashDraftMin: 4,
  dflashDraftMax: 24,
  mlock: true,
  noMmap: false,
  kvSpillToCpu: false,
};

/**
 * RTX 5090 — Blackwell, 32 GiB, FP8/FP4 first-class.
 *
 * Best current release fit: Eliza-1 4B. Blackwell sm_120 is new enough that
 * the Polar/QJL kernels may not be pre-built — the runtime should probe
 * `CAPABILITIES.json` and surface a structured error rather than silently
 * falling back.
 */
const RTX_5090: GpuProfile = {
  id: "rtx-5090",
  displayName: "NVIDIA GeForce RTX 5090",
  vramGb: 32,
  computeCapability: "sm_120",
  memoryBandwidthGBs: 1792,
  fp8: true,
  recommendedBundles: ["eliza-1-4b", "eliza-1-2b", "eliza-1-0_8b"],
  flashAttn: true,
  kvCacheTypeK: "qjl1_256",
  kvCacheTypeV: "q4_polar",
  nGpuLayers: -1,
  contextSize: 262144,
  parallel: 8,
  batchSize: 4096,
  ubatchSize: 1024,
  dflashDraftMin: 4,
  dflashDraftMax: 24,
  mlock: true,
  noMmap: false,
  kvSpillToCpu: false,
};

/**
 * H200 — Hopper, 141 GiB HBM3e, 4.8 TB/s.
 *
 * Best current release fit: Eliza-1 4B. H200 still runs the full kernel
 * verification recipe, but 27B/1M remains a hidden future tier until final
 * weights and release evidence exist.
 */
const H200: GpuProfile = {
  id: "h200",
  displayName: "NVIDIA H200 (SXM 141 GiB)",
  vramGb: 141,
  computeCapability: "sm_90",
  memoryBandwidthGBs: 4800,
  fp8: true,
  recommendedBundles: ["eliza-1-4b", "eliza-1-2b", "eliza-1-0_8b"],
  flashAttn: true,
  kvCacheTypeK: "qjl1_256",
  kvCacheTypeV: "q4_polar",
  nGpuLayers: -1,
  contextSize: 1_048_576,
  parallel: 16,
  batchSize: 4096,
  ubatchSize: 2048,
  dflashDraftMin: 8,
  dflashDraftMax: 32,
  mlock: true,
  noMmap: false,
  kvSpillToCpu: false,
};

export const GPU_PROFILES: Readonly<Record<GpuProfileId, GpuProfile>> = {
  "rtx-3090": RTX_3090,
  "rtx-4090": RTX_4090,
  "rtx-5090": RTX_5090,
  h200: H200,
};

export const GPU_PROFILE_IDS: ReadonlyArray<GpuProfileId> = [
  "rtx-3090",
  "rtx-4090",
  "rtx-5090",
  "h200",
];

/**
 * Match an `nvidia-smi --query-gpu=name` output line to a profile. Returns
 * `null` when the card is not in the supported set; callers should fall
 * back to the catalog defaults in that case rather than guess.
 *
 * The patterns are intentionally strict to avoid mis-classifying a 3080
 * as a 3090, or an A100 as a 4090.
 */
export function matchGpuProfile(gpuName: string): GpuProfileId | null {
  const n = gpuName.toLowerCase();
  if (n.includes("h200")) return "h200";
  if (n.includes("rtx 5090") || n.includes("rtx5090")) return "rtx-5090";
  if (n.includes("rtx 4090") || n.includes("rtx4090")) return "rtx-4090";
  if (n.includes("rtx 3090") || n.includes("rtx3090")) return "rtx-3090";
  return null;
}

/**
 * Returns the headroom (in GiB) a profile reserves for the OS / driver /
 * activations / drafter / N parallel-slot KV. Used for sizing checks
 * before promoting a bundle to "fits" on a card.
 *
 * The figures are deliberate per-tier reserves, not a formula — different
 * cards have different driver overheads (Windows display drivers steal
 * ~1 GiB before workloads even start; H200 SXM has none).
 */
export function reservedHeadroomGb(profile: GpuProfile): number {
  switch (profile.id) {
    case "rtx-3090":
      return 3;
    case "rtx-4090":
      return 3;
    case "rtx-5090":
      return 4;
    case "h200":
      return 6;
  }
}
