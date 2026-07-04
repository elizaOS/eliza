/**
 * Local inference catalog re-exports.
 *
 * The canonical catalog (Eliza-1 tier ids, default-eligibility set,
 * `MODEL_CATALOG`, HuggingFace URL builders) lives in
 * `@elizaos/shared/local-inference`. This shim preserves the historical
 * import path `./catalog` for server-side code.
 */

export {
	buildHuggingFaceResolveUrl,
	buildHuggingFaceResolveUrlCandidatesForPath,
	buildHuggingFaceResolveUrlForPath,
	DEFAULT_ELIGIBLE_MODEL_IDS,
	ELIZA_1_HF_REPO,
	ELIZA_1_HOSTED_MTP_TIER_IDS,
	ELIZA_1_MTP_TIER_IDS,
	ELIZA_1_ON_DEVICE_TIER_IDS,
	ELIZA_1_PLACEHOLDER_IDS,
	ELIZA_1_RELEASE_TIER_IDS,
	ELIZA_1_TIER_IDS,
	ELIZA_1_TIER_PUBLISH_STATUS,
	ELIZA_1_VISION_TIER_IDS,
	type Eliza1TierId,
	eliza1TierPublishStatus,
	FIRST_RUN_DEFAULT_MODEL_ID,
	findCatalogModel,
	type HfResolveUrlCandidate,
	hasHuggingFaceToken,
	isDefaultEligibleId,
	isHuggingFaceHost,
	isOnDeviceTier,
	MODEL_CATALOG,
	resolveHfDownloadBase,
	resolveHubAuthHeaders,
	resolveHuggingFaceToken,
} from "@elizaos/shared";
