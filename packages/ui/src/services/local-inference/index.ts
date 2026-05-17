export type { LocalInferenceLoader } from "./active-model";
export {
  ELIZA_1_PLACEHOLDER_IDS,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  MODEL_CATALOG,
} from "./catalog";
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
export { getDflashRuntimeStatus } from "./dflash-server";
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
  ModelBucket,
  ModelCategory,
  ModelHubSnapshot,
  TextGenerationSlot,
} from "./types";
