/**
 * Local inference type re-exports.
 *
 * The canonical definitions live in `@elizaos/plugin-native-inference/model-catalog`.
 * This shim preserves the historical import path
 * `../services/local-inference/types` for server-side code.
 */

export { type ActiveModelState, AGENT_MODEL_SLOTS, type AgentModelSlot, type CatalogModel, type CatalogQuantizationId, type CatalogQuantizationMatrix, type CatalogQuantizationVariant, type CpuFeatureProbe, type DownloadEvent, type DownloadJob, type DownloadState, type HardwareFitLevel, type HardwareProbe, type InstalledModel, type LocalInferenceDownloadStatus, type LocalInferenceReadiness, type LocalInferenceSlotReadiness, type LocalRuntimeAcceleration, type LocalRuntimeBackend, type LocalRuntimeKernel, type LocalRuntimeOptimizations, type MobileHardwareProbe, type ModelAssignments, type ModelBucket, type ModelCategory, type ModelHubSnapshot, type OpenVinoDeviceKind, type OpenVinoHardwareProbe, TEXT_GENERATION_SLOTS, type TextGenerationSlot, type TokenizerFamily } from "@elizaos/core/contracts/local-inference";
export { classifyCatalogModelRuntimeClass, classifyInstalledModelRuntimeClass, type RuntimeClass, withRuntimeClass } from "@elizaos/plugin-native-inference/model-catalog/runtime-class";
export { type GpuProfile, type GpuProfileId, type KvCacheType } from "@elizaos/plugin-native-inference/model-catalog/gpu-profiles";

/** RAM requirements for a model bundle. */
export interface RamBudget {
	/** Minimum RAM the bundle will boot under, in megabytes. */
	minMb: number;
	/** RAM the bundle expects for nominal workloads, in megabytes. */
	recommendedMb: number;
	/** Where the numbers came from. `manifest` only when both came from
	 *  a validated `eliza-1.manifest.json` next to the installed bundle. */
	source: "manifest" | "catalog";
}
