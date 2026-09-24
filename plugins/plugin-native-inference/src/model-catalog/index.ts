/**
 * @elizaos/plugin-native-inference/model-catalog
 *
 * Shared local-inference contract used by both the server-side service
 * (`@elizaos/app/src/services/local-inference`) and the UI client
 * (`@elizaos/ui/src/services/local-inference`). Type definitions live
 * here; runtime logic stays in `app` (server-side KV cache
 * management, llama-server lifecycle, conversation registry, metrics)
 * and `ui` (client wiring against the agent API).
 */

export { BGE_EMBEDDING_MODEL } from "@elizaos/plugin-native-inference/model-catalog/bge-embedding-model";
export {
  buildHuggingFaceResolveUrl,
  buildHuggingFaceResolveUrlCandidatesForPath,
  buildHuggingFaceResolveUrlForPath,
  DEFAULT_ELIGIBLE_MODEL_IDS,
  ELIZA_1_BUNDLE_SLUGS,
  ELIZA_1_HF_REPO,
  ELIZA_1_HOSTED_MTP_TIER_IDS,
  ELIZA_1_MTP_TIER_IDS,
  ELIZA_1_ON_DEVICE_TIER_IDS,
  ELIZA_1_PLACEHOLDER_IDS,
  ELIZA_1_PUBLISHED_SLUGS,
  ELIZA_1_PUBLISHED_TIER_IDS,
  ELIZA_1_RELEASE_TIER_IDS,
  ELIZA_1_TIER_IDS,
  ELIZA_1_TIER_PUBLISH_STATUS,
  ELIZA_1_VISION_TIER_IDS,
  type Eliza1TierId,
  eliza1TierPublishStatus,
  FIRST_RUN_DEFAULT_MODEL_ID,
  findCatalogModel,
  type HfResolveUrlCandidate,
  isDefaultEligibleId,
  isEliza1TierId,
  isEliza1TierPublished,
  isOnDeviceTier,
  MODEL_CATALOG,
  tierBundleSlug,
  tierPublishedSlug,
} from "@elizaos/plugin-native-inference/model-catalog/catalog";
export {
  ELIZA_1_CONTEXT_TARGET,
  ELIZA_1_KV_QUANT,
  ELIZA_1_MIN_LOCAL_CONTEXT,
  type Eliza1Fit,
  selectBestEliza1Fit,
} from "@elizaos/plugin-native-inference/model-catalog/device-fit";
export {
  GPU_PROFILE_IDS,
  GPU_PROFILES,
  type GpuProfile,
  type GpuProfileId,
  type KvCacheType,
  matchGpuProfile,
  reservedHeadroomGb,
} from "@elizaos/plugin-native-inference/model-catalog/gpu-profiles";
export {
  type HfDownloadBase,
  resolveHfDownloadBase,
  resolveHfDownloadBases,
} from "@elizaos/plugin-native-inference/model-catalog/hf-proxy";
export {
  hasHuggingFaceToken,
  isHuggingFaceHost,
  resolveHubAuthHeaders,
  resolveHuggingFaceToken,
} from "@elizaos/plugin-native-inference/model-catalog/hub-auth";
export {
  type Ed25519PublicKey,
  ManifestSignatureError,
  type SignatureVerifyInput,
  verifyManifestSignature,
  verifyManifestSignatureText,
} from "@elizaos/plugin-native-inference/model-catalog/manifest-signature";
export {
  applyNetworkPolicy,
  classifyNetwork,
  DEFAULT_NETWORK_POLICY_PREFERENCES,
  evaluateNetworkPolicy,
  inQuietHours,
  type NetworkClass,
  type NetworkPolicyDecision,
  type NetworkPolicyPreferences,
  type NetworkPolicyReason,
  type RawNetworkState,
} from "@elizaos/plugin-native-inference/model-catalog/network-policy";
export type {
  ProviderEnableState,
  ProviderId,
  ProviderMeta,
  ProviderStatus,
} from "@elizaos/core/contracts/local-inference-providers";
export {
  type ArmCpuBackendAdmission,
  assessCatalogModelFit,
  catalogDownloadSizeBytes,
  catalogDownloadSizeGb,
  chooseSmallerFallbackModel,
  classifyRecommendationPlatform,
  type LocalInferenceRecommendationPolicy,
  type RecommendationOptions,
  type RecommendationPlatformClass,
  type RecommendationRamBudget,
  type RecommendedModelSelection,
  RUNTIME_LOCAL_INFERENCE_RECOMMENDATION_POLICY,
  recommendForFirstRun,
  selectRecommendedModelForSlot,
  selectRecommendedModels,
  UI_LOCAL_INFERENCE_RECOMMENDATION_POLICY,
} from "@elizaos/plugin-native-inference/model-catalog/recommendation";
export type {
  RoutingPolicy,
  RoutingPreferences,
} from "@elizaos/plugin-native-inference/model-catalog/routing-policy";
export {
  DEFAULT_ROUTING_POLICY,
  isRoutingPolicy,
  ROUTING_POLICIES,
} from "@elizaos/plugin-native-inference/model-catalog/routing-policy";
export {
  classifyCatalogModelRuntimeClass,
  classifyInstalledModelRuntimeClass,
  type RuntimeClass,
  withRuntimeClass,
} from "@elizaos/plugin-native-inference/model-catalog/runtime-class";
export {
  computeGenerationThroughput,
  type GenerationCounters,
  type GenerationThroughput,
  isGenerationCounters,
} from "@elizaos/plugin-native-inference/model-catalog/throughput";
export {
  type ActiveModelState,
  AGENT_MODEL_SLOTS,
  type AgentModelSlot,
  type CatalogModel,
  type CatalogQuantizationId,
  type CatalogQuantizationMatrix,
  type CatalogQuantizationVariant,
  type CpuFeatureProbe,
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
  type OpenVinoDeviceKind,
  type OpenVinoHardwareProbe,
  TEXT_GENERATION_SLOTS,
  type TextGenerationSlot,
  type TokenizerFamily,
} from "@elizaos/core/contracts/local-inference";
export type { VerifyResult, VerifyState } from "@elizaos/plugin-native-inference/model-catalog/verify";
export {
  compareVoiceModelSemver,
  findVoiceModelVersion,
  latestVoiceModelVersion,
  VOICE_MODEL_VERSIONS,
  type VoiceModelEvalDeltas,
  type VoiceModelGgufAsset,
  type VoiceModelId,
  type VoiceModelQuant,
  type VoiceModelVersion,
  versionsFor,
} from "@elizaos/plugin-native-inference/model-catalog/voice-models";
