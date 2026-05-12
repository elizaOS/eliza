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
  InferenceTelemetry,
  inferenceTelemetry,
  type TelemetryTags,
} from "./inference-telemetry";
export {
  estimateQuantizedKvBytesPerToken,
  KV_SPILL_MIN_CONTEXT,
  type KvGeometry,
  type KvRestoreClass,
  type KvSpillPlan,
  KvSpillUnsupportedError,
  planKvSpill,
} from "./kv-spill";
export {
  buildVoiceLatencyDevPayload,
  EndToEndLatencyTracer,
  endVoiceLatencyTurn,
  type HistogramSummary,
  LATENCY_DERIVED_KEYS,
  type LatencyCheckpoint,
  type LatencyDerived,
  type LatencyDerivedKey,
  type LatencyTrace,
  markVoiceLatency,
  type TracerOptions,
  VOICE_CHECKPOINTS,
  type VoiceCheckpoint,
  type VoiceLatencyDevPayload,
  voiceLatencyTracer,
} from "./latency-trace";
export {
  diffSnapshots,
  fetchMetricsSnapshot,
  type LlamaServerMetricSnapshot,
  type LocalUsageBlock,
  parsePrometheusMetrics,
} from "./llama-server-metrics";
export { buildTextGenerationReadiness } from "./readiness";
export {
  assessCatalogModelFit,
  type BundleDefaultEligibility,
  canBundleBeDefaultOnDevice,
  catalogDownloadSizeBytes,
  catalogDownloadSizeGb,
  chooseSmallerFallbackModel,
  classifyRecommendationPlatform,
  deviceCapsFromProbe,
  type RecommendationPlatformClass,
  type RecommendedModelSelection,
  recommendForFirstRun,
  selectBestQuantizationVariant,
  selectRecommendedModelForSlot,
  selectRecommendedModels,
} from "./recommendation";
export {
  dispatchGenerate,
  type DispatchGenerateInput,
  type HttpStreamingAdapter,
  type InferenceStreamEvent,
} from "./runtime-dispatcher";
export {
  inferencePlatformClass,
  inferenceRuntimeMode,
  type InferenceRuntimeMode,
  type InferenceRuntimeModeInput,
  isCapacitorNativeRuntime,
  readRuntimeModeEnvOverride,
  type SupportedHostPlatform,
} from "./runtime-target";
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
