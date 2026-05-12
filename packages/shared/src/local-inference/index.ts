/**
 * @elizaos/shared/local-inference
 *
 * Shared local-inference contract used by both the server-side service
 * (`@elizaos/app-core/src/services/local-inference`) and the UI client
 * (`@elizaos/ui/src/services/local-inference`). Type definitions live
 * here; runtime logic stays in `app-core` (server-side KV cache
 * management, llama-server lifecycle, conversation registry, metrics)
 * and `ui` (client wiring against the agent API).
 */

export {
  buildHuggingFaceResolveUrl,
  buildHuggingFaceResolveUrlForPath,
  DEFAULT_ELIGIBLE_MODEL_IDS,
  ELIZA_1_PLACEHOLDER_IDS,
  ELIZA_1_TIER_IDS,
  type Eliza1TierId,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  isDefaultEligibleId,
  MODEL_CATALOG,
} from "./catalog.js";
export {
  downloadsStagingDir,
  elizaModelsDir,
  isWithinElizaRoot,
  localInferenceRoot,
  registryPath,
} from "./paths.js";
export type {
  ProviderEnableState,
  ProviderId,
  ProviderMeta,
  ProviderStatus,
} from "./providers-types.js";
export {
  DEFAULT_ROUTING_POLICY,
  type RoutingPolicy,
  type RoutingPreferences,
  readRoutingPreferences,
  setPolicy,
  setPreferredProvider,
  writeRoutingPreferences,
} from "./routing-preferences.js";
export {
  type ActiveModelState,
  AGENT_MODEL_SLOTS,
  type AgentModelSlot,
  type CatalogModel,
  type DownloadEvent,
  type DownloadJob,
  type DownloadState,
  type HardwareFitLevel,
  type HardwareProbe,
  type InstalledModel,
  type LocalInferenceDownloadStatus,
  type LocalInferenceReadiness,
  type LocalInferenceSlotReadiness,
  type LocalRuntimeAcceleration,
  type LocalRuntimeBackend,
  type LocalRuntimeKernel,
  type LocalRuntimeOptimizations,
  type MobileHardwareProbe,
  type ModelAssignments,
  type ModelBucket,
  type ModelCategory,
  type ModelHubSnapshot,
  TEXT_GENERATION_SLOTS,
  type TextGenerationSlot,
  type TokenizerFamily,
} from "./types.js";
export {
  __registryPathForTests,
  hashFile,
  type VerifyResult,
  type VerifyState,
  verifyInstalledModel,
} from "./verify.js";
export {
  GPU_PROFILE_IDS,
  GPU_PROFILES,
  type GpuProfile,
  type GpuProfileId,
  type KvCacheType,
  matchGpuProfile,
  reservedHeadroomGb,
} from "./gpu-profiles.js";
