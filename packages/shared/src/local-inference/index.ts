/**
 * @elizaos/shared/local-inference
 *
 * Shared local-inference contract used by both the server-side service
 * (`@elizaos/app-core/src/services/local-inference`) and the UI client
 * (`@elizaos/ui/src/services/local-inference`). Type definitions live
 * here; runtime logic stays in `app-core` (server-side KV cache
 * management, llama-server lifecycle, conversation registry, metrics)
 * and `ui` (client wiring against the agent API).
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
  isDefaultEligibleId,
  isOnDeviceTier,
  MODEL_CATALOG,
} from "./catalog.js";
export {
  ELIZA_1_CONTEXT_TARGET,
  ELIZA_1_KV_QUANT,
  ELIZA_1_MIN_LOCAL_CONTEXT,
  type Eliza1Fit,
  selectBestEliza1Fit,
} from "./device-fit.js";
export {
  GPU_PROFILE_IDS,
  GPU_PROFILES,
  type GpuProfile,
  type GpuProfileId,
  type KvCacheType,
  matchGpuProfile,
  reservedHeadroomGb,
} from "./gpu-profiles.js";
export {
  type HfDownloadBase,
  resolveHfDownloadBase,
  resolveHfDownloadBases,
} from "./hf-proxy.js";
export {
  hasHuggingFaceToken,
  isHuggingFaceHost,
  resolveHubAuthHeaders,
  resolveHuggingFaceToken,
} from "./hub-auth.js";
export {
  type Ed25519PublicKey,
  ManifestSignatureError,
  type SignatureVerifyInput,
  verifyManifestSignature,
  verifyManifestSignatureText,
} from "./manifest-signature.js";
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
} from "./network-policy.js";
export type {
  ProviderEnableState,
  ProviderId,
  ProviderMeta,
  ProviderStatus,
} from "./providers-types.js";
export type {
  RoutingPolicy,
  RoutingPreferences,
} from "./routing-preferences.js";
export {
  DEFAULT_ROUTING_POLICY,
  isRoutingPolicy,
  ROUTING_POLICIES,
} from "./routing-preferences.js";
export {
  classifyCatalogModelRuntimeClass,
  classifyInstalledModelRuntimeClass,
  type RuntimeClass,
  withRuntimeClass,
} from "./runtime-class.js";
export {
  computeGenerationThroughput,
  type GenerationCounters,
  type GenerationThroughput,
  isGenerationCounters,
} from "./throughput.js";
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
} from "./types.js";
export type { VerifyResult, VerifyState } from "./verify.js";
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
} from "./voice-models.js";
