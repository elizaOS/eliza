/**
 * Runtime hand-off: produce the `Partial<MtpServerOptions>` overrides
 * the FFI runtime should apply when launching `llama-server` on CUDA.
 *
 * The actual integration site lives in
 * `packages/app-core/src/services/local-inference/ffi-streaming-backend.ts` —
 * that file is owned by another agent. This module just produces the
 * patch object; the runtime is expected to merge it on top of the
 * catalog defaults before spawning the server. See `MTP_SERVER_PATCH`
 * below for the documented integration diff (NOT applied here).
 *
 * Single-GPU only: no tensor-split, no NVLink. If `gpuOptions.nGpuLayers`
 * is `-1` the whole model goes to the one card.
 */
import type { Eliza1TierId } from "../local-inference/catalog.js";

import {
  type BundleRecommendation,
  type GpuYamlProfile,
  getRecommendationsByTier,
  type KvCacheType,
} from "./gpu-profile-schema.js";

/**
 * Shape of the override patch the runtime applies. Mirrors the subset
 * of `MtpServerOptions` that the YAML profiles touch — keeping it
 * structural avoids an import cycle with app-core (which depends on
 * shared, not the other way around).
 */
export interface MtpServerOverrides {
  contextSize?: number;
  parallel?: number;
  batchSize?: number;
  ubatchSize?: number;
  nGpuLayers?: number;
  flashAttention?: boolean;
  mlock?: boolean;
  cacheTypeK?: KvCacheType;
  cacheTypeV?: KvCacheType;
  // MTP-specific.
  draftMin?: number;
  draftMax?: number;
  draftGpuLayers?: number;
}

export interface GpuOverridesInput {
  profile: GpuYamlProfile;
  bundleId: Eliza1TierId;
}

/**
 * Result wrapper distinguishing "no recommendation for this bundle"
 * (the YAML has no key for the requested tier — runtime should fall
 * back to catalog defaults) from "applied" (here is the merge patch).
 */
export type GpuOverridesResult =
  | {
      kind: "applied";
      bundleId: Eliza1TierId;
      gpuId: string;
      overrides: MtpServerOverrides;
    }
  | { kind: "no-recommendation"; bundleId: Eliza1TierId; gpuId: string };

/**
 * Compute the runtime override patch for a (bundle, profile) pair.
 *
 * - If the YAML has a `bundle_recommendations[<bundleId>]` entry, return
 *   `applied` with the merged MTP + bundle flags.
 * - If not, return `no-recommendation` — runtime keeps catalog defaults.
 *
 * Pure: no IO, no logging. Safe to call repeatedly.
 */
export function getGpuOverrides(input: GpuOverridesInput): GpuOverridesResult {
  const { profile, bundleId } = input;
  const recs = getRecommendationsByTier(profile);
  const rec = recs[bundleId];
  if (!rec) {
    return { kind: "no-recommendation", bundleId, gpuId: profile.gpu_id };
  }
  return {
    kind: "applied",
    bundleId,
    gpuId: profile.gpu_id,
    overrides: bundleToOverrides(rec, profile, bundleId),
  };
}

function bundleToOverrides(
  rec: BundleRecommendation,
  profile: GpuYamlProfile,
  bundleId: Eliza1TierId,
): MtpServerOverrides {
  const out: MtpServerOverrides = {
    contextSize: rec.ctx_size,
    parallel: rec.parallel,
    batchSize: rec.batch_size,
    ubatchSize: rec.ubatch_size,
    nGpuLayers: rec.n_gpu_layers,
    flashAttention: rec.flash_attention,
    cacheTypeK: rec.kv_cache_k,
    cacheTypeV: rec.kv_cache_v,
  };
  if (rec.mlock !== undefined) out.mlock = rec.mlock;
  if (profile.mtp.enabled && bundleId !== "eliza-1-0_8b") {
    out.draftMin = profile.mtp.draft_min;
    out.draftMax = profile.mtp.draft_max;
    out.draftGpuLayers = profile.mtp.draft_gpu_layers;
  }
  return out;
}

/**
 * Documented 5-line integration patch for
 * `packages/app-core/src/services/local-inference/ffi-streaming-backend.ts`.
 *
 * **NOT applied here.** Another agent owns ffi-streaming-backend.ts. Producing
 * the diff in a string keeps the integration point reviewable without
 * touching the locked file.
 *
 * Target site: inside `buildLaunchArgs` (or wherever the catalog
 * `runtime.optimizations` is merged into the final spawn config),
 * after the catalog defaults are loaded and before flags are flattened
 * to argv.
 *
 * ```ts
 * // After: const plan = buildPlanFromCatalog(model, env);
 * // Add:
 * if (plan.acceleration?.backend === "cuda") {
 *   const host = resolveProfileForHost();
 *   if (host.ok) {
 *     const patch = getGpuOverrides({ profile: host.profile, bundleId: model.id as Eliza1TierId });
 *     if (patch.kind === "applied") Object.assign(plan, patch.overrides);
 *   }
 * }
 * ```
 *
 * `resolveProfileForHost` is from `gpu-profile-loader.ts`;
 * `getGpuOverrides` is the function above. The merge is a shallow
 * `Object.assign` because every field of `MtpServerOverrides` is a
 * leaf scalar — there are no nested objects to deep-merge.
 */
export const MTP_SERVER_PATCH_DOCS =
  "see comment block above MTP_SERVER_PATCH_DOCS";
