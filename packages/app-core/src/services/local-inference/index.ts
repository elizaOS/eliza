export type { LocalInferenceLoader } from "./active-model";
export {
  type BackendDecision,
  BackendDispatcher,
  type BackendOverride,
  type BackendPlan,
  decideBackend,
  type EmbedArgs,
  type EmbedResult,
  type GenerateArgs as BackendGenerateArgs,
  type GenerateResult,
  type LocalInferenceBackend,
  readBackendOverride,
  resolveCatalogForPlan,
} from "./backend";
export {
  ELIZA_1_PLACEHOLDER_IDS,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  MODEL_CATALOG,
} from "./catalog";
export {
  type CloudCandidate,
  type CloudFallbackOptions,
  classifyLocalError,
  type FallbackReason,
  findCloudCandidate,
  type LocalGenerateOutcome,
  makeCloudFallbackHandler,
} from "./cloud-fallback";
export { getDflashRuntimeStatus } from "./dflash-server";
export { assessFit, probeHardware } from "./hardware";
export {
  estimateQuantizedKvBytesPerToken,
  KV_SPILL_MIN_CONTEXT,
  type KvGeometry,
  type KvRestoreClass,
  type KvSpillPlan,
  KvSpillUnsupportedError,
  planKvSpill,
} from "./kv-spill";
export { buildTextGenerationReadiness } from "./readiness";
export {
  assessCatalogModelFit,
  catalogDownloadSizeBytes,
  catalogDownloadSizeGb,
  chooseSmallerFallbackModel,
  classifyRecommendationPlatform,
  type RecommendationPlatformClass,
  type RecommendedModelSelection,
  recommendForFirstRun,
  selectRecommendedModelForSlot,
  selectRecommendedModels,
} from "./recommendation";
export { LocalInferenceService, localInferenceService } from "./service";
export type {
  ActiveModelState,
  CatalogModel,
  DownloadEvent,
  DownloadJob,
  DownloadState,
  HardwareFitLevel,
  HardwareProbe,
  InstalledModel,
  LocalInferenceDownloadStatus,
  LocalInferenceReadiness,
  LocalInferenceSlotReadiness,
  LocalRuntimeAcceleration,
  LocalRuntimeBackend,
  LocalRuntimeKernel,
  LocalRuntimeOptimizations,
  ModelBucket,
  ModelCategory,
  ModelHubSnapshot,
  TextGenerationSlot,
} from "./types";
