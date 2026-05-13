/**
 * Per-GPU llama.cpp autotune.
 *
 * Turns a detected GPU (`{ name, totalMemoryMiB }`) into a fully resolved
 * `llama-server` flag set, optionally narrowed for a specific bundle id.
 *
 * The static profile defaults live in `@elizaos/shared`
 * (`gpu-profiles.ts`); this module layers the per-GPU JSON configs at
 * `packages/inference/configs/gpu/*.json` on top, and adds bundle-aware
 * overrides + a VRAM-bucket fallback for cards we don't have a tuned
 * profile for.
 *
 * Resolution order (later wins):
 *
 *   1. `GPU_PROFILES[id]` static defaults.
 *   2. Bundled `GPU_CONFIGS[id]` JSON overlay (this file).
 *   3. Bundle-specific overrides (`bundle_recommendations.<bundle>`).
 *   4. Per-call `overrides` arg.
 *
 * Pure functions only; no FS access, no process.env reads — env-var
 * application happens at the dflash-server spawn site. Tests in
 * `__tests__/gpu-autotune.test.ts`.
 *
 * Scope: single-GPU only — never split layers across cards in this
 * tier.
 */

import {
  GPU_PROFILES,
  type GpuProfile,
  type GpuProfileId,
  matchGpuProfile,
} from "@elizaos/shared";

/** Minimum input the helper needs to make a choice. */
export interface GpuInfo {
  /** Raw GPU name from `nvidia-smi --query-gpu=name`. */
  name: string;
  /** Total VRAM in MiB (also from `nvidia-smi --query-gpu=memory.total`). */
  totalMemoryMiB: number;
}

/** Resolved llama-server flag set returned by `selectGpuConfig`. */
export interface LlamaServerFlags {
  n_gpu_layers: number;
  ctx_size: number;
  batch_size: number;
  ubatch_size: number;
  n_parallel: number;
  cache_type_k: string;
  cache_type_v: string;
  flash_attn: boolean;
  split_mode: "none" | "layer" | "row";
  main_gpu: number;
  mlock: boolean;
  no_mmap: boolean;
  no_kv_offload: boolean;
  ctx_checkpoints: number;
  ctx_checkpoint_interval: number;
  draft_max: number;
  draft_min: number;
  draft_p_min: number;
}

/** Per-bundle override block read from `bundle_recommendations`. */
export interface BundleRecommendation {
  ctx_size?: number;
  max_parallel?: number;
  batch_size?: number;
  ubatch_size?: number;
  cache_type_k?: string;
  cache_type_v?: string;
  no_kv_offload?: boolean;
}

/** Per-GPU expected metrics. All values flagged as extrapolated until measured. */
export interface ExpectedMetrics {
  ttfa_p50_ms: number;
  ttfa_p95_ms: number;
  rtf: number;
  tokens_per_second_decode?: number;
  _provenance: "measured" | "extrapolated";
}

/** Full per-GPU JSON config; mirrors `gpu-config.schema.json`. */
export interface GpuConfig {
  id: GpuProfileId;
  name: string;
  match_names: string[];
  vram_gb: number;
  compute_capability: string;
  arch: "ampere" | "ada-lovelace" | "blackwell" | "hopper";
  memory_bandwidth_gbs: number;
  fp8: boolean;
  fp4: boolean;
  flash_attn_3: boolean;
  llama_server_flags: LlamaServerFlags;
  bundle_recommendations: Record<string, BundleRecommendation>;
  expected_metrics: ExpectedMetrics;
  known_limits: string[];
}

/** Fallback bucket — used when `matchGpuProfile` returns null. */
export interface FallbackBucket {
  max_vram_gb: number;
  config_id: GpuProfileId | null;
  label: string;
  parallel_scale?: number;
}

/**
 * Result of `selectGpuConfig`. `source` records why we chose this
 * config so the runtime can log it (especially when a fallback bucket
 * fired).
 */
export interface SelectedGpuConfig {
  config: GpuConfig;
  flags: LlamaServerFlags;
  /** Bundle id we narrowed against, or `null` when unscoped. */
  bundleId: string | null;
  /** "match" = exact name match, "bucket" = VRAM fallback. */
  source: "match" | "bucket";
  /** Bucket label when `source === "bucket"`; undefined otherwise. */
  bucketLabel?: string;
}

// ---------------------------------------------------------------------------
// Static config table (mirrors packages/inference/configs/gpu/*.json).
//
// We inline the JSON to keep this module FS-agnostic (so it works in
// browser bundles and worker contexts). Whenever the JSON files change,
// regenerate this constant — `gpu-autotune.test.ts` enforces the table
// matches the files on disk by spot-checking key fields.
// ---------------------------------------------------------------------------

export const GPU_CONFIGS: Readonly<Record<GpuProfileId, GpuConfig>> = {
  "rtx-3090": {
    id: "rtx-3090",
    name: "NVIDIA GeForce RTX 3090",
    match_names: ["RTX 3090", "GeForce RTX 3090", "RTX 3090 Ti"],
    vram_gb: 24,
    compute_capability: "8.6",
    arch: "ampere",
    memory_bandwidth_gbs: 936,
    fp8: false,
    fp4: false,
    flash_attn_3: false,
    llama_server_flags: {
      n_gpu_layers: 999,
      ctx_size: 65536,
      batch_size: 2048,
      ubatch_size: 512,
      n_parallel: 4,
      cache_type_k: "q8_0",
      cache_type_v: "q4_polar",
      flash_attn: true,
      split_mode: "none",
      main_gpu: 0,
      mlock: true,
      no_mmap: false,
      no_kv_offload: false,
      ctx_checkpoints: 8,
      ctx_checkpoint_interval: 8192,
      draft_max: 16,
      draft_min: 4,
      draft_p_min: 0.5,
    },
    bundle_recommendations: {
      voice: {
        ctx_size: 8192,
        max_parallel: 4,
        batch_size: 1024,
        ubatch_size: 256,
      },
      "eliza-1-1_7b": {
        ctx_size: 32768,
        max_parallel: 8,
        cache_type_k: "q8_0",
        cache_type_v: "q4_0",
      },
      "eliza-1-4b": { ctx_size: 65536, max_parallel: 4 },
      "eliza-1-9b": { ctx_size: 65536, max_parallel: 4 },
      "eliza-1-27b": { ctx_size: 32768, max_parallel: 2 },
    },
    expected_metrics: {
      ttfa_p50_ms: 320,
      ttfa_p95_ms: 500,
      rtf: 0.55,
      tokens_per_second_decode: 95,
      _provenance: "extrapolated",
    },
    known_limits: [
      "no FP8 tensor cores",
      "no FP4",
      "flash-attn-3 unsupported (Hopper-only)",
      "qjl1_256 K kernel not built for sm_86 — q8_0 K fallback",
      "27B + ctx >= 32k requires single slot and is tight on 24 GiB",
    ],
  },
  "rtx-4090": {
    id: "rtx-4090",
    name: "NVIDIA GeForce RTX 4090",
    match_names: ["RTX 4090", "GeForce RTX 4090"],
    vram_gb: 24,
    compute_capability: "8.9",
    arch: "ada-lovelace",
    memory_bandwidth_gbs: 1008,
    fp8: true,
    fp4: false,
    flash_attn_3: false,
    llama_server_flags: {
      n_gpu_layers: 999,
      ctx_size: 32768,
      batch_size: 2048,
      ubatch_size: 512,
      n_parallel: 8,
      cache_type_k: "qjl1_256",
      cache_type_v: "q4_polar",
      flash_attn: true,
      split_mode: "none",
      main_gpu: 0,
      mlock: true,
      no_mmap: false,
      no_kv_offload: false,
      ctx_checkpoints: 8,
      ctx_checkpoint_interval: 8192,
      draft_max: 24,
      draft_min: 4,
      draft_p_min: 0.5,
    },
    bundle_recommendations: {
      voice: {
        ctx_size: 8192,
        max_parallel: 4,
        batch_size: 1024,
        ubatch_size: 256,
      },
      "eliza-1-1_7b": { ctx_size: 65536, max_parallel: 16 },
      "eliza-1-4b": { ctx_size: 65536, max_parallel: 8 },
      "eliza-1-9b": { ctx_size: 65536, max_parallel: 8 },
      "eliza-1-27b": { ctx_size: 32768, max_parallel: 2 },
    },
    expected_metrics: {
      ttfa_p50_ms: 220,
      ttfa_p95_ms: 320,
      rtf: 0.4,
      tokens_per_second_decode: 140,
      _provenance: "extrapolated",
    },
    known_limits: [
      "flash-attn-3 unsupported (Hopper-only); uses flash-attn-2",
      "FP4 not supported on sm_89",
      "27B + 32k context is single-slot only",
    ],
  },
  "rtx-5090": {
    id: "rtx-5090",
    name: "NVIDIA GeForce RTX 5090",
    match_names: ["RTX 5090", "GeForce RTX 5090"],
    vram_gb: 32,
    compute_capability: "12.0",
    arch: "blackwell",
    memory_bandwidth_gbs: 1792,
    fp8: true,
    fp4: true,
    flash_attn_3: true,
    llama_server_flags: {
      n_gpu_layers: 999,
      ctx_size: 65536,
      batch_size: 4096,
      ubatch_size: 1024,
      n_parallel: 12,
      cache_type_k: "qjl1_256",
      cache_type_v: "q4_polar",
      flash_attn: true,
      split_mode: "none",
      main_gpu: 0,
      mlock: true,
      no_mmap: false,
      no_kv_offload: false,
      ctx_checkpoints: 16,
      ctx_checkpoint_interval: 8192,
      draft_max: 24,
      draft_min: 4,
      draft_p_min: 0.5,
    },
    bundle_recommendations: {
      voice: {
        ctx_size: 8192,
        max_parallel: 8,
        batch_size: 1024,
        ubatch_size: 256,
      },
      "eliza-1-1_7b": { ctx_size: 131072, max_parallel: 24 },
      "eliza-1-4b": { ctx_size: 131072, max_parallel: 12 },
      "eliza-1-9b": { ctx_size: 131072, max_parallel: 12 },
      "eliza-1-27b": { ctx_size: 65536, max_parallel: 4 },
      "eliza-1-27b-256k": {
        ctx_size: 262144,
        max_parallel: 1,
        no_kv_offload: true,
      },
    },
    expected_metrics: {
      ttfa_p50_ms: 160,
      ttfa_p95_ms: 240,
      rtf: 0.3,
      tokens_per_second_decode: 220,
      _provenance: "extrapolated",
    },
    known_limits: [
      "sm_120 kernel coverage in llama.cpp is early; QJL/Polar requires CAPABILITIES.json probe",
      "flash-attn-3 supported but tuned for sm_90 (Hopper) first",
      "27B-256k is single-slot only and requires kvSpillToCpu opt-in",
    ],
  },
  h200: {
    id: "h200",
    name: "NVIDIA H200 (SXM 141 GiB)",
    match_names: ["H200", "NVIDIA H200"],
    vram_gb: 141,
    compute_capability: "9.0",
    arch: "hopper",
    memory_bandwidth_gbs: 4800,
    fp8: true,
    fp4: false,
    flash_attn_3: true,
    llama_server_flags: {
      n_gpu_layers: 999,
      ctx_size: 262144,
      batch_size: 4096,
      ubatch_size: 2048,
      n_parallel: 16,
      cache_type_k: "qjl1_256",
      cache_type_v: "q4_polar",
      flash_attn: true,
      split_mode: "none",
      main_gpu: 0,
      mlock: true,
      no_mmap: false,
      no_kv_offload: false,
      ctx_checkpoints: 16,
      ctx_checkpoint_interval: 8192,
      draft_max: 32,
      draft_min: 8,
      draft_p_min: 0.5,
    },
    bundle_recommendations: {
      voice: {
        ctx_size: 16384,
        max_parallel: 32,
        batch_size: 2048,
        ubatch_size: 512,
      },
      "eliza-1-1_7b": { ctx_size: 1048576, max_parallel: 64 },
      "eliza-1-4b": { ctx_size: 1048576, max_parallel: 32 },
      "eliza-1-9b": { ctx_size: 1048576, max_parallel: 32 },
      "eliza-1-27b": { ctx_size: 131072, max_parallel: 16 },
      "eliza-1-27b-256k": { ctx_size: 262144, max_parallel: 6 },
      "eliza-1-27b-1m": { ctx_size: 1048576, max_parallel: 2 },
    },
    expected_metrics: {
      ttfa_p50_ms: 110,
      ttfa_p95_ms: 180,
      rtf: 0.2,
      tokens_per_second_decode: 320,
      _provenance: "extrapolated",
    },
    known_limits: [
      "FP4 not supported on sm_90 (Blackwell-only)",
      "27B-1M @ parallel > 2 requires prefix sharing via radix cache",
      "PCIe spill path defeats the bandwidth advantage; keep KV in HBM",
    ],
  },
};

/**
 * VRAM-bucket fallback table. Ordered ascending by `max_vram_gb`; the
 * first row whose threshold the GPU does NOT exceed wins. `config_id`
 * `null` means we have no useful profile (give up; let the caller fall
 * through to the catalog defaults).
 */
export const FALLBACK_BUCKETS: ReadonlyArray<FallbackBucket> = [
  { max_vram_gb: 12, config_id: null, label: "tiny" },
  {
    max_vram_gb: 18,
    config_id: "rtx-3090",
    label: "small",
    parallel_scale: 0.5,
  },
  { max_vram_gb: 28, config_id: "rtx-3090", label: "mid" },
  {
    max_vram_gb: 40,
    config_id: "rtx-5090",
    label: "mid-plus",
    parallel_scale: 0.5,
  },
  { max_vram_gb: 80, config_id: "rtx-5090", label: "large" },
  { max_vram_gb: 9999, config_id: "h200", label: "huge" },
];

/**
 * Pick a `GpuConfig` for a detected GPU.
 *
 * 1. Try the exact-name matcher in `@elizaos/shared`.
 * 2. If that fails, fall through to the first VRAM bucket whose
 *    threshold the GPU does NOT exceed.
 * 3. Return `null` only when no bucket applies.
 */
export function selectGpuConfig(
  gpu: GpuInfo,
  opts: { bundleId?: string; overrides?: Partial<LlamaServerFlags> } = {},
): SelectedGpuConfig | null {
  const matchedId = matchGpuProfile(gpu.name);
  if (matchedId) {
    return finalize({
      config: GPU_CONFIGS[matchedId],
      bundleId: opts.bundleId ?? null,
      overrides: opts.overrides,
      source: "match",
    });
  }

  const vramGb = gpu.totalMemoryMiB / 1024;
  const bucket = pickFallbackBucket(vramGb);
  if (!bucket?.config_id) return null;

  return finalize({
    config: GPU_CONFIGS[bucket.config_id],
    bundleId: opts.bundleId ?? null,
    overrides: opts.overrides,
    source: "bucket",
    bucketLabel: bucket.label,
    parallelScale: bucket.parallel_scale,
  });
}

/** Pick the first bucket whose `max_vram_gb` the GPU does NOT exceed. */
export function pickFallbackBucket(vramGb: number): FallbackBucket | null {
  for (const b of FALLBACK_BUCKETS) {
    if (vramGb <= b.max_vram_gb) return b;
  }
  return null;
}

function finalize(args: {
  config: GpuConfig;
  bundleId: string | null;
  overrides?: Partial<LlamaServerFlags>;
  source: "match" | "bucket";
  bucketLabel?: string;
  parallelScale?: number;
}): SelectedGpuConfig {
  const baseFlags: LlamaServerFlags = { ...args.config.llama_server_flags };

  // Apply bundle recommendation if present.
  if (args.bundleId) {
    const rec = args.config.bundle_recommendations[args.bundleId];
    if (rec) {
      if (typeof rec.ctx_size === "number") baseFlags.ctx_size = rec.ctx_size;
      if (typeof rec.max_parallel === "number") {
        baseFlags.n_parallel = rec.max_parallel;
      }
      if (typeof rec.batch_size === "number") {
        baseFlags.batch_size = rec.batch_size;
      }
      if (typeof rec.ubatch_size === "number") {
        baseFlags.ubatch_size = rec.ubatch_size;
      }
      if (typeof rec.cache_type_k === "string") {
        baseFlags.cache_type_k = rec.cache_type_k;
      }
      if (typeof rec.cache_type_v === "string") {
        baseFlags.cache_type_v = rec.cache_type_v;
      }
      if (typeof rec.no_kv_offload === "boolean") {
        baseFlags.no_kv_offload = rec.no_kv_offload;
      }
    }
  }

  // Scale parallel down for under-spec bucket fallbacks.
  if (args.source === "bucket" && args.parallelScale !== undefined) {
    baseFlags.n_parallel = Math.max(
      1,
      Math.floor(baseFlags.n_parallel * args.parallelScale),
    );
  }

  // Per-call overrides — final word.
  if (args.overrides) {
    Object.assign(baseFlags, args.overrides);
  }

  return {
    config: args.config,
    flags: baseFlags,
    bundleId: args.bundleId,
    source: args.source,
    ...(args.bucketLabel ? { bucketLabel: args.bucketLabel } : {}),
  };
}

/**
 * Convert resolved `LlamaServerFlags` to the canonical `llama-server`
 * argv list. Mirrors the flag names llama.cpp actually accepts —
 * `dflash-server.ts` is the existing producer of these flags and is
 * the source of truth for naming; this helper exists for tests and for
 * the voice-bench harness.
 */
export function flagsToLlamaServerArgv(flags: LlamaServerFlags): string[] {
  const argv: string[] = [];
  argv.push("--n-gpu-layers", String(flags.n_gpu_layers));
  argv.push("--ctx-size", String(flags.ctx_size));
  argv.push("--batch-size", String(flags.batch_size));
  argv.push("--ubatch-size", String(flags.ubatch_size));
  argv.push("--parallel", String(flags.n_parallel));
  argv.push("--cache-type-k", flags.cache_type_k);
  argv.push("--cache-type-v", flags.cache_type_v);
  if (flags.flash_attn) argv.push("-fa", "on");
  argv.push("--split-mode", flags.split_mode);
  argv.push("--main-gpu", String(flags.main_gpu));
  if (flags.mlock) argv.push("--mlock");
  if (flags.no_mmap) argv.push("--no-mmap");
  if (flags.no_kv_offload) argv.push("--no-kv-offload");
  argv.push("--draft-min", String(flags.draft_min));
  argv.push("--draft-max", String(flags.draft_max));
  // ctx-checkpoints/interval are only meaningful when the runtime probe
  // says the fork supports them; the spawn site applies them conditionally.
  argv.push("--ctx-checkpoints", String(flags.ctx_checkpoints));
  argv.push("--ctx-checkpoint-interval", String(flags.ctx_checkpoint_interval));
  return argv;
}

/**
 * Cross-check: return the static `GpuProfile` for a `GpuConfig`. Used
 * by the dflash-server spawn site to feed `applyGpuProfile()` with the
 * matching `GpuProfile` while keeping the JSON the source of truth for
 * per-bundle overrides.
 */
export function staticProfileFor(config: GpuConfig): GpuProfile {
  return GPU_PROFILES[config.id];
}
