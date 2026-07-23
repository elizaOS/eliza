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
  ELIZA_1_BUNDLE_SLUGS,
  ELIZA_1_HF_REPO,
  ELIZA_1_HOSTED_MTP_TIER_IDS,
  ELIZA_1_MTP_TIER_IDS,
  ELIZA_1_PLACEHOLDER_IDS,
  ELIZA_1_PUBLISHED_SLUGS,
  ELIZA_1_PUBLISHED_TIER_IDS,
  ELIZA_1_TIER_IDS,
  ELIZA_1_TIER_PUBLISH_STATUS,
  type Eliza1TierId,
  eliza1TierPublishStatus,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  isDefaultEligibleId,
  isEliza1TierId,
  isEliza1TierPublished,
  MODEL_CATALOG,
  tierBundleSlug,
  tierPublishedSlug,
} from "@elizaos/shared";
