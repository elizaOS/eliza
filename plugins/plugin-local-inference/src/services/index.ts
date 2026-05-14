export type { LocalInferenceLoader } from "./active-model";
export {
	assertVoiceBundleFitsHost,
	VoiceBundleDoesNotFitError,
} from "./active-model";
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
export { type DeviceBridgeStatus, deviceBridge } from "./device-bridge";
export {
	classifyDeviceTier,
	DEVICE_TIER_ORDER,
	DEVICE_TIER_THRESHOLDS,
	type DeviceTier,
	type DeviceTierAssessment,
	effectiveModelMemoryGb,
	type RecommendedMode,
	TIER_WARNING_COPY,
	totalRamMb,
} from "./device-tier";
export {
	type DflashDoctorCheck,
	type DflashDoctorReport,
	type DflashDoctorStatus,
	runDflashDoctor,
} from "./dflash-doctor";
export { getDflashRuntimeStatus } from "./dflash-server";
export {
	LocalInferenceEngine,
	localInferenceEngine,
	resolveIdleUnloadMs,
	resolveMaxConcurrentSpeculativeResponses,
} from "./engine";
export {
	type HandlerRegistration,
	handlerRegistry,
	type PublicRegistration,
	toPublicRegistration,
} from "./handler-registry";
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
export * from "./manifest/index";
export {
	type ArbiterCapability,
	type ArbiterEvent,
	type ArbiterEventListener,
	type ArbiterHandle,
	type CapabilityRegistration,
	getMemoryArbiter,
	MemoryArbiter,
	type MemoryArbiterOptions,
	setMemoryArbiter,
	tryGetMemoryArbiter,
} from "./memory-arbiter";
export {
	type CapacitorPressureSource,
	capacitorPressureSource,
	compositePressureSource,
	type MemoryPressureEvent,
	type MemoryPressureLevel,
	type MemoryPressureListener,
	type MemoryPressureSource,
	nodeOsPressureSource,
} from "./memory-pressure";
export {
	MLX_BACKEND_ID,
	MlxLocalServer,
	mlxBackendEligible,
	mlxLocalServer,
} from "./mlx-server";
export {
	buildPlanActionsSkeleton,
	buildPlannerGuidedDecode,
	type PlannerAction,
	type PlannerGuidedDecode,
	planActionParameterSchema,
} from "./planner-skeleton";
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
	type DispatchGenerateInput,
	dispatchGenerate,
	type HttpStreamingAdapter,
	type InferenceStreamEvent,
} from "./runtime-dispatcher";
export {
	type InferenceRuntimeMode,
	type InferenceRuntimeModeInput,
	inferencePlatformClass,
	inferenceRuntimeMode,
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
export {
	VisionEmbeddingCache,
	type VisionEmbeddingCacheConfig,
	type VisionEmbeddingEntry,
} from "./vision-embedding-cache";
export * from "./voice/index";
