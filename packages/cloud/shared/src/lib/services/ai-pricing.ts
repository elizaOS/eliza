// Public barrel for AI pricing. Implementation is split across ./ai-pricing/*.
// Public symbol names must remain stable — consumers import directly from this
// module path.

export {
  chooseBestCandidatePricingEntry,
  expandPricingCatalogModelCandidates,
} from "./ai-pricing/candidate-selection";
export {
  buildDimensionKey,
  canonicalModelId,
  inferProviderFromCanonicalModel,
  normalizePricingDimensions,
  providerForPricingCandidate,
} from "./ai-pricing/dimensions";
export {
  calculateImageGenerationCostFromCatalog,
  calculateMusicGenerationCostFromCatalog,
  calculateSfxGenerationCostFromCatalog,
  calculateSTTCostFromCatalog,
  calculateTextCostFromCatalog,
  calculateTTSCostFromCatalog,
  calculateVideoGenerationCostFromCatalog,
  calculateVoiceCloneCostFromCatalog,
  getDefaultVideoBillingDimensions,
  listPersistedPricingEntries,
  listRecentPricingRefreshRuns,
} from "./ai-pricing/lookup";
export { buildBitRouterPreparedEntries } from "./ai-pricing/providers/bitrouter";
export { refreshPricingCatalog } from "./ai-pricing/refresh";
export { stripVersionedSnapshotSuffix } from "./ai-pricing/suffix-stripping";
export type { FlatOperationCost, TokenCostBreakdown } from "./ai-pricing/types";
