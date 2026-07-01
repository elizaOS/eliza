/**
 * Local inference type re-exports.
 *
 * The canonical definitions live in `@elizaos/shared/local-inference`.
 * This shim preserves the historical import path
 * `../services/local-inference/types` for server-side code.
 */

export {
	type ActiveModelState,
	AGENT_MODEL_SLOTS,
	type AgentModelSlot,
	type CatalogModel,
	type CatalogQuantizationId,
	type CatalogQuantizationMatrix,
	type CatalogQuantizationVariant,
	type CpuFeatureProbe,
	classifyCatalogModelRuntimeClass,
	classifyInstalledModelRuntimeClass,
	type DownloadEvent,
	type DownloadJob,
	type DownloadState,
	type GpuProfile,
	type GpuProfileId,
	type HardwareFitLevel,
	type HardwareProbe,
	type InstalledModel,
	type KvCacheType,
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
	type OpenVinoDeviceKind,
	type OpenVinoHardwareProbe,
	type RuntimeClass,
	TEXT_GENERATION_SLOTS,
	type TextGenerationSlot,
	type TokenizerFamily,
	withRuntimeClass,
} from "@elizaos/shared";

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
