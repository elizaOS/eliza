/**
 * Barrel for the local-inference service: catalog, readiness, assignments,
 * downloader, and engine surface.
 */

export type {
  ActiveModelState,
  CatalogModel,
  DownloadEvent,
  DownloadJob,
  DownloadState,
  GenerationCounters,
  GenerationThroughput,
  HardwareFitLevel,
  HardwareProbe,
  InstalledModel,
  LocalInferenceDownloadStatus,
  LocalInferenceReadiness,
  LocalInferenceSlotReadiness,
  ModelBucket,
  ModelCategory,
  ModelHubSnapshot,
  TextGenerationSlot,
} from "@elizaos/shared";
export {
  computeGenerationThroughput,
  ELIZA_1_PLACEHOLDER_IDS,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  isGenerationCounters,
  MODEL_CATALOG,
} from "@elizaos/shared/local-inference/index";
export type { LocalInferenceLoader } from "./active-model";
export {
  filterSettingsDefaultLocalModels,
  isDefaultLocalModelFamily,
  isEliza1ModelFamilyId,
  isSettingsDefaultLocalModel,
} from "./catalog-policy";
export {
  DEFAULT_LOCAL_MODEL_SEARCH_PROVIDER_ID,
  getLocalModelSearchProvider,
  isLocalModelSearchProviderId,
  type LocalModelSearchProviderDescriptor,
  type LocalModelSearchProviderId,
  type LocalModelSearchResponse,
  type LocalModelSearchResult,
  listLocalModelSearchProviders,
  searchLocalModelProvider,
  wrapLocalModelSearchResults,
} from "./custom-search";
export { assessFit, probeHardware } from "./hardware";
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
export {
  type DeviceResourceSnapshot,
  getDeviceResourceSnapshot,
  normalizeResourceSnapshot,
  type SnapshotThermalState,
} from "./resource-snapshot-bridge";
export { LocalInferenceService, localInferenceService } from "./service";
