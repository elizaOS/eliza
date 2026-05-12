/**
 * @elizaos/shared/local-inference-gpu
 *
 * Per-GPU YAML profile system for single-GPU Eliza-1 deployments.
 *
 * Pairs with the constant-only descriptor in
 * `packages/shared/src/local-inference/gpu-profiles.ts`:
 *
 *   - `gpu-profiles.ts` ships the import-safe TypeScript constants used
 *     by mobile / edge bundles that cannot do file IO at runtime.
 *
 *   - The YAML files here ship the same card-level metadata *plus*
 *     per-bundle tuning (n_gpu_layers, ctx_size, parallel, batch
 *     sizing, KV cache types, expected TPS) and the verification
 *     recipe (CUDA arch, cmake flags, required kernels). They are the
 *     source of truth for the verify scripts and the dflash-server
 *     override path.
 *
 * Importing this module is safe in node-only environments. It does NOT
 * pull in `nvidia-smi` at module load — detection runs lazily inside
 * `resolveProfileForHost`.
 */

export {
  __clearProfileCacheForTests,
  __setNvidiaSmiMockForTests,
  classifyGpuName,
  detectGpuFromNvidiaSmi,
  FALLBACK_PROFILE_ID,
  loadProfile,
  profileYamlPath,
  type ResolveResult,
  resolveProfileForHost,
} from "./gpu-profile-loader.js";
export {
  type DflashServerOverrides,
  DFLASH_SERVER_PATCH_DOCS,
  getGpuOverrides,
  type GpuOverridesInput,
  type GpuOverridesResult,
} from "./gpu-overrides.js";
export {
  type BundleRecommendation,
  bundleIdsInProfileMatchCatalog,
  type DflashTuning,
  getRecommendationsByTier,
  type GpuYamlId,
  type GpuYamlProfile,
  GpuYamlProfile as GpuYamlProfileSchema,
  type KernelName,
  type KvCacheType,
  type VerifyRecipe,
} from "./gpu-profile-schema.js";
