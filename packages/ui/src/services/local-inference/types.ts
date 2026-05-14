/**
 * Local inference type re-exports.
 *
 * The canonical definitions live in `@elizaos/shared/local-inference`.
 * This shim preserves the historical import path
 * `../services/local-inference/types` for UI code.
 */

export {
  type ActiveModelState,
  AGENT_MODEL_SLOTS,
  type AgentModelSlot,
  type CatalogModel,
  type CatalogQuantizationId,
  type CatalogQuantizationMatrix,
  type CatalogQuantizationVariant,
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
} from "@elizaos/shared";
