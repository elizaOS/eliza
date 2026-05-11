/**
 * Local inference catalog re-exports.
 *
 * The canonical catalog (Eliza-1 tier ids, default-eligibility set,
 * `MODEL_CATALOG`, HuggingFace URL builders) lives in
 * `@elizaos/shared/local-inference`. This shim preserves the historical
 * import path `../services/local-inference/catalog` for UI code.
 */

export {
  buildHuggingFaceResolveUrl,
  buildHuggingFaceResolveUrlForPath,
  DEFAULT_ELIGIBLE_MODEL_IDS,
  ELIZA_1_PLACEHOLDER_IDS,
  ELIZA_1_TIER_IDS,
  type Eliza1TierId,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  isDefaultEligibleId,
  MODEL_CATALOG,
} from "@elizaos/shared";
