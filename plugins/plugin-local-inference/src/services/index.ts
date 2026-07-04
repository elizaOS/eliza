/** Public surface of the local-inference service layer: backend dispatch, catalog, engine, arbiter, downloader, routing, and registry helpers. */
export type { LocalInferenceLoader } from "./active-model";
export {
	assertVoiceBundleFitsHost,
	VoiceBundleDoesNotFitError,
} from "./active-model";
export {
	type BackendDecision,
	BackendDispatcher,
	type BackendId,
	type BackendOverride,
	type BackendPlan,
	decideBackend,
	ELIZA_LLM_BACKEND_ENV,
	type GenerateArgs as BackendGenerateArgs,
	type GenerateResult,
	type LocalInferenceBackend,
	litertBackendSupported,
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
export {
	computeRuntimeContextFit,
	type RuntimeContextFit,
	type RuntimeContextFitInput,
} from "./context-fit";
export {
	buildDeviceResourceMetricsDevPayload,
	type DeviceBridgeStatus,
	type DeviceGenerationMetrics,
	type DeviceResourceMetricsDevPayload,
	deviceBridge,
} from "./device-bridge";
export {
	type BatterySummary,
	DeviceResourceMetrics,
	type DeviceResourceSummary,
	type DeviceThermalState,
	type GenerationObservation,
	type LowPowerSummary,
	type ResourceSample,
	type RssSummary,
	type ThermalSummary,
	type ThermalTransition,
} from "./device-resource-metrics";
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
	createImageDescriptionRuntime,
	type ImageDescriptionRuntime,
	type ImageDescriptionRuntimeOptions,
} from "./image-description-runtime";
export {
	type CapabilityProbes,
	defaultsForNoBinding,
	type InferenceCapabilities,
	probeCapabilities,
	type ResourceSnapshot,
	type ThermalState,
	type ThermalThrottleDecision,
	thermalThrottleDecision,
} from "./inference-capabilities";
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
	type BuildLocalModelLifecycleMatrixOptions,
	buildLocalModelLifecycleMatrix,
	collectLocalLifecycleFileChecks,
	formatLocalModelLifecycleMatrixMarkdown,
	type LifecycleBundleRemoteCheck,
	type LifecycleCheck,
	type LifecycleCheckStatus,
	type LifecycleLocalFileCheck,
	type LifecycleRemoteCheck,
	type LocalModelLifecycleArtifact,
	type LocalModelLifecycleComponent,
	type LocalModelLifecycleMatrix,
	type LocalModelLifecycleRow,
	lifecycleArtifactKey,
	listLocalModelLifecycleArtifacts,
} from "./local-model-lifecycle-matrix";
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
	buildMemoryBenchmarkPlan,
	buildMemoryBenchmarkReport,
	type MemoryBenchmarkLoadResult,
	type MemoryBenchmarkModelPlan,
	type MemoryBenchmarkOptions,
	type MemoryBenchmarkReport,
	runMemoryBenchmark,
	summarizeMemoryBenchmark,
} from "./memory-benchmark";
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
	type MtpDoctorCheck,
	type MtpDoctorCheckStatus,
	type MtpDoctorReport,
	runMtpDoctor,
} from "./mtp-doctor";
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
	getVisionContextAugmenter,
	registerVisionContextAugmenter,
	type VisionAugmentResult,
	type VisionContextAugmenter,
	type VisionFusedContext,
} from "./vision/augmenter";
export {
	VisionEmbeddingCache,
	type VisionEmbeddingCacheConfig,
	type VisionEmbeddingEntry,
} from "./vision-embedding-cache";
export * from "./voice/index";
