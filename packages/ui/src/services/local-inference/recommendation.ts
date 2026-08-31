/**
 * Compatibility facade for the canonical browser-safe local-inference
 * recommendation policy owned by `@elizaos/shared/local-inference`.
 */

export {
  assessCatalogModelFit,
  catalogDownloadSizeBytes,
  catalogDownloadSizeGb,
  chooseSmallerFallbackModel,
  classifyRecommendationPlatform,
  type RecommendationOptions,
  type RecommendationPlatformClass,
  type RecommendedModelSelection,
  recommendForFirstRun,
  selectRecommendedModelForSlot,
  selectRecommendedModels,
} from "@elizaos/shared/local-inference";
