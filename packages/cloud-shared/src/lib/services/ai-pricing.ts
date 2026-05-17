// Public barrel for AI pricing. Implementation is split across ./ai-pricing/*.
// Public symbol names must remain stable — consumers import directly from this
// module path.

export type { FlatOperationCost, TokenCostBreakdown } from "./ai-pricing/types";
export {
  buildDimensionKey,
  normalizePricingDimensions,
  providerForPricingCandidate,
} from "./ai-pricing/dimensions";
export { stripVersionedSnapshotSuffix } from "./ai-pricing/suffix-stripping";
export {
  chooseBestCandidatePricingEntry,
  expandPricingCatalogModelCandidates,
} from "./ai-pricing/candidate-selection";
export { buildOpenRouterPreparedEntries } from "./ai-pricing/providers/openrouter";
export {
  calculateImageGenerationCostFromCatalog,
  calculateMusicGenerationCostFromCatalog,
  calculateSTTCostFromCatalog,
  calculateTextCostFromCatalog,
  calculateTTSCostFromCatalog,
  calculateVideoGenerationCostFromCatalog,
  calculateVoiceCloneCostFromCatalog,
  getDefaultVideoBillingDimensions,
  listPersistedPricingEntries,
  listRecentPricingRefreshRuns,
} from "./ai-pricing/lookup";
export { refreshPricingCatalog } from "./ai-pricing/refresh";
