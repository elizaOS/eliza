/**
 * Zod schema for the per-GPU YAML profile files in
 * `packages/shared/src/local-inference-gpu/profiles/*.yaml`.
 *
 * The YAML files are the source of truth for *per-bundle* deployment
 * recommendations on a given card (n_gpu_layers, ctx_size, parallel,
 * batch sizing, KV cache types, expected TPS). The card-level
 * descriptive metadata (vram, bandwidth, FP8 support) is duplicated
 * here so a single YAML round-trip captures everything an operator
 * needs to deploy and verify.
 *
 * The runtime card-level descriptor in
 * `packages/shared/src/local-inference/gpu-profiles.ts` is the *other*
 * source of truth — it carries the same constants but is tree-shakable
 * and import-safe in environments without YAML / file IO (mobile
 * runtime, edge bundles). At load time we cross-validate the two so
 * they cannot drift silently.
 */
import { z } from "zod";

import { ELIZA_1_TIER_IDS, type Eliza1TierId } from "../local-inference/catalog.js";

/**
 * Card ids — must match `GpuProfileId` in
 * `packages/shared/src/local-inference/gpu-profiles.ts`. Duplicated here
 * to keep this schema module standalone (no runtime import cycle).
 */
export const GpuYamlId = z.enum(["rtx-3090", "rtx-4090", "rtx-5090", "h200"]);
export type GpuYamlId = z.infer<typeof GpuYamlId>;

/** KV cache type strings accepted by `llama-server --cache-type-k/-v`. */
export const KvCacheType = z.enum([
  "f16",
  "q8_0",
  "q4_0",
  "qjl1_256",
  "q4_polar",
  "turbo3_0",
  "turbo4_0",
]);
export type KvCacheType = z.infer<typeof KvCacheType>;

export const KernelName = z.enum([
  "dflash",
  "turbo3",
  "turbo4",
  "turbo3_tcq",
  "qjl_full",
  "polarquant",
]);
export type KernelName = z.infer<typeof KernelName>;

/** Per-bundle llama-server flag bundle. */
export const BundleRecommendation = z.object({
  n_gpu_layers: z.number().int(),
  ctx_size: z.number().int().positive(),
  parallel: z.number().int().positive(),
  batch_size: z.number().int().positive(),
  ubatch_size: z.number().int().positive(),
  kv_cache_k: KvCacheType,
  kv_cache_v: KvCacheType,
  flash_attention: z.boolean(),
  // Some profiles set `mlock`; others omit. Default = false at load time.
  mlock: z.boolean().optional(),
  // Throughput expectations — used by verify scripts' tolerance check.
  // `estimated_decode_tps` is the steady-state generation rate; the
  // prefill number is total tokens/sec across the batch on a long input.
  estimated_decode_tps: z.number().positive(),
  estimated_prefill_tps: z.number().positive(),
  notes: z.string().optional(),
});
export type BundleRecommendation = z.infer<typeof BundleRecommendation>;

export const DflashTuning = z.object({
  enabled: z.boolean(),
  draft_min: z.number().int().positive(),
  draft_max: z.number().int().positive(),
  draft_gpu_layers: z.number().int(),
});
export type DflashTuning = z.infer<typeof DflashTuning>;

export const VerifyRecipe = z.object({
  build_target: z.string(),
  cuda_arch: z.number().int().positive(),
  cmake_flags: z.array(z.string()).min(1),
  expected_kernels: z.array(KernelName).min(1),
  unavailable_kernels: z.array(KernelName).default([]),
  // Optional flags some profiles set (e.g. 5090 warns instead of fails
  // when a kernel is absent — Blackwell ports are still maturing).
  warn_on_kernel_absent: z.boolean().optional(),
  smoke_bundle: z.string(),
  tolerance_pct: z.number().positive(),
});
export type VerifyRecipe = z.infer<typeof VerifyRecipe>;

/** Full per-GPU YAML profile. */
export const GpuYamlProfile = z.object({
  gpu_id: GpuYamlId,
  gpu_arch: z.string().regex(/^sm_\d{2,3}$/, "expected sm_XX"),
  vram_gb: z.number().positive(),
  mem_bandwidth_gbps: z.number().positive(),
  fp8_supported: z.boolean(),
  fp4_supported: z.boolean(),
  nvlink: z.boolean(),
  bundle_recommendations: z.record(z.string(), BundleRecommendation),
  dflash: DflashTuning,
  verify_recipe: VerifyRecipe,
});
export type GpuYamlProfile = z.infer<typeof GpuYamlProfile>;

/**
 * Validate that every bundle id in `bundle_recommendations` is a real
 * Eliza-1 tier id. Returns the list of offending keys (empty when OK).
 *
 * Kept out of the zod schema itself because `record(z.string(), …)` is
 * the right shape for forward-compat — the YAML may reference a new
 * tier id before the catalog enum is bumped, and we want a clear error
 * rather than a cryptic union-mismatch.
 */
export function bundleIdsInProfileMatchCatalog(profile: GpuYamlProfile): {
  ok: boolean;
  unknown: string[];
} {
  const known = new Set<string>(ELIZA_1_TIER_IDS);
  const unknown: string[] = [];
  for (const id of Object.keys(profile.bundle_recommendations)) {
    if (!known.has(id)) unknown.push(id);
  }
  return { ok: unknown.length === 0, unknown };
}

/** Narrowed mapping of tier id -> recommendation, after catalog validation. */
export function getRecommendationsByTier(
  profile: GpuYamlProfile,
): Partial<Record<Eliza1TierId, BundleRecommendation>> {
  const out: Partial<Record<Eliza1TierId, BundleRecommendation>> = {};
  const known = new Set<string>(ELIZA_1_TIER_IDS);
  for (const [k, v] of Object.entries(profile.bundle_recommendations)) {
    if (known.has(k)) out[k as Eliza1TierId] = v;
  }
  return out;
}
