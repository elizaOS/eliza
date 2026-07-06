import type { IAgentRuntime, Plugin, ProcessEnvLike } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
// Cloud providers
import { cloudStatusProvider } from "./cloud-providers/cloud-status";
import { containerHealthProvider } from "./cloud-providers/container-health";
import { creditBalanceProvider } from "./cloud-providers/credit-balance";
import { modelRegistryProvider } from "./cloud-providers/model-registry";
import { initializeOpenAI } from "./init";
import {
  fetchTextToSpeech,
  handleActionPlanner,
  handleImageDescription,
  handleImageGeneration,
  handleAudioGeneration,
  handleResearch,
  handleResponseHandler,
  handleBatchTextEmbedding,
  handleTextEmbedding,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
  handleTextToSpeech,
  handleTranscription,
  handleVideoGeneration,
} from "./models";
// Cloud services
import { CloudAuthService } from "./services/cloud-auth";
import { CloudBackupService } from "./services/cloud-backup";
import { CloudBootstrapServiceImpl } from "./services/cloud-bootstrap";
import { CloudBridgeService } from "./services/cloud-bridge";
import { CloudContainerService } from "./services/cloud-container";
import { CloudCredentialProvider } from "./services/cloud-credential-provider";
import { CloudManagedGatewayRelayService } from "./services/cloud-managed-gateway-relay";
import { CloudModelRegistryService } from "./services/cloud-model-registry";
import {
  getActionPlannerModel,
  getLargeModel,
  getMediumModel,
  getMegaModel,
  getNanoModel,
  getResponseHandlerModel,
  getSetting,
  getSmallModel,
} from "./utils/config";
import { createCloudApiClient } from "./utils/sdk-client";
import { createWaifuMeteringHandler } from "./utils/waifu-metering";

const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as string;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as string;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as string;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ?? "RESPONSE_HANDLER") as string;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as string;

const cloudEmbeddingModels: NonNullable<Plugin["models"]> = {
  [ModelType.TEXT_EMBEDDING]: handleTextEmbedding,
  [ModelType.TEXT_EMBEDDING_BATCH]: (runtime, params: { texts: string[] }) =>
    handleBatchTextEmbedding(runtime, params.texts),
};

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();

// ─── Chat-brain text-inference handlers ───────────────────────────────
// Registered from init() rather than the static `models` map so a host can
// run a DIFFERENT text brain (a CLI/SDK subscription provider, a local
// model, …) while keeping Cloud's capability handlers — IMAGE,
// IMAGE_DESCRIPTION, TEXT_TO_SPEECH, embeddings, RESEARCH — active. At
// priority 50 a static registration silently steals the chat-brain slots
// from priority-0 provider plugins whenever a Cloud key is present, which
// forced hosts to nuke ELIZAOS_CLOUD_API_KEY wholesale and lose image/media
// generation as collateral (elizaOS/eliza#10819).
//
// The host expresses the arbitration decision through
// ELIZAOS_CLOUD_USE_INFERENCE (written by applyCloudConfigToEnv):
//   - explicit "false"  → another provider owns the chat brain; skip these
//                         handlers, capability handlers stay registered.
//   - "true" or unset   → Cloud serves the chat brain (unset preserves
//                         standalone plugin use outside the agent host).
// Mirrors plugin-openai's registerMediaModels() conditional-registration
// pattern; init() runs before the runtime's static-models registration
// loop, so both paths land in the same priority-sorted registry.
const textInferenceModels: NonNullable<Plugin["models"]> = {
  [TEXT_NANO_MODEL_TYPE]: handleTextNano,
  [TEXT_MEDIUM_MODEL_TYPE]: handleTextMedium,
  [ModelType.TEXT_SMALL]: handleTextSmall,
  [ModelType.TEXT_LARGE]: handleTextLarge,
  [TEXT_MEGA_MODEL_TYPE]: handleTextMega,
  [RESPONSE_HANDLER_MODEL_TYPE]: handleResponseHandler,
  [ACTION_PLANNER_MODEL_TYPE]: handleActionPlanner,
};

// Per-slot resolvers for the concrete model id each chat-brain handler will
// call — the same getters `getModelNameForType` (models/text.ts) uses per
// request. The cloud tier resolution (`ELIZAOS_CLOUD_*_MODEL` → bare `*_MODEL`
// → code default) lives entirely in this plugin, so the runtime's model
// self-report (RUNTIME_MODEL_CONTEXT) can only name the concrete model when
// registration declares it as `metadata.displayModel`; without it a
// cloud-brained agent asked "what model are you?" can name its provider
// adapter but not its model. Resolved once at registration — a post-boot tier
// setting change shows up on the next registration, not live.
const textInferenceDisplayModels: Record<string, (runtime: IAgentRuntime) => string> = {
  [TEXT_NANO_MODEL_TYPE]: getNanoModel,
  [TEXT_MEDIUM_MODEL_TYPE]: getMediumModel,
  [ModelType.TEXT_SMALL]: getSmallModel,
  [ModelType.TEXT_LARGE]: getLargeModel,
  [TEXT_MEGA_MODEL_TYPE]: getMegaModel,
  [RESPONSE_HANDLER_MODEL_TYPE]: getResponseHandlerModel,
  [ACTION_PLANNER_MODEL_TYPE]: getActionPlannerModel,
};

function isExplicitFalseFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "false";
}

export function registerTextInferenceModels(runtime: IAgentRuntime): void {
  const flag = getSetting(runtime, "ELIZAOS_CLOUD_USE_INFERENCE");
  if (flag?.trim().toLowerCase() === "false") {
    logger.info(
      "[ElizaOSCloud] Not registering chat-brain text handlers: ELIZAOS_CLOUD_USE_INFERENCE=false (another provider owns the text brain; image/media/TTS/embedding handlers stay active)"
    );
    return;
  }
  for (const [modelType, handler] of Object.entries(textInferenceModels)) {
    runtime.registerModel(
      modelType,
      handler as Parameters<IAgentRuntime["registerModel"]>[1],
      elizaOSCloudPlugin.name,
      elizaOSCloudPlugin.priority,
      { displayModel: textInferenceDisplayModels[modelType](runtime) }
    );
  }
}

export function registerCloudEmbeddingModels(runtime: IAgentRuntime): void {
  const flag = getSetting(runtime, "ELIZAOS_CLOUD_USE_EMBEDDINGS");
  if (isExplicitFalseFlag(flag)) {
    logger.info(
      "[ElizaOSCloud] Not registering cloud embedding handlers: ELIZAOS_CLOUD_USE_EMBEDDINGS=false (another provider owns TEXT_EMBEDDING)"
    );
    return;
  }
  for (const [modelType, handler] of Object.entries(cloudEmbeddingModels)) {
    runtime.registerModel(
      modelType,
      handler as Parameters<IAgentRuntime["registerModel"]>[1],
      elizaOSCloudPlugin.name,
      elizaOSCloudPlugin.priority
    );
  }
}

export const elizaOSCloudPlugin: Plugin = {
  name: "elizaOSCloud",
  description:
    "ElizaOS Cloud plugin — Multi-model AI generation, container provisioning, agent bridge, and billing management",
  autoEnable: {
    envKeys: ["ELIZAOS_CLOUD_API_KEY", "ELIZAOS_CLOUD_ENABLED"],
  },

  // Plugin-wide registration priority. Applied to every model handler in
  // the `models` map below. Higher numbers win the native runtime priority
  // sort.
  //
  // Why 50: in `manual` routing mode (`routing-preferences.ts`) with no
  // `preferredProvider` set for a slot, the runtime falls through to the
  // native priority order. Putting cloud above the default-0 of other
  // direct provider plugins (anthropic, openai, groq, elevenlabs) means
  // Eliza Cloud wins the "user has paired Cloud but hasn't picked anything
  // specific" case — which is the desired text-generation default.
  //
  // **TTS routing precedence is governed by the router-handler**
  // (`plugin-local-inference/src/services/router-handler.ts`) at
  // MAX_SAFE_INTEGER priority, which reads the per-slot `RoutingPolicy`
  // (default `prefer-local`) and dispatches to local first when available.
  // This plugin's priority does NOT control whether local TTS wins; the
  // router does. See `plugin-local-inference/native/AGENTS.md` §1 for the
  // canonical voice/ASR routing contract.
  //
  // Cloud TTS still works as a fallback when local is unavailable: the
  // handler throws `CloudTtsUnavailableError` when cloud isn't connected
  // and the router's per-pick retry loop falls through to the next
  // eligible provider (local Kokoro, plugin-elevenlabs, ...).
  priority: 50,

  config: {
    ELIZAOS_CLOUD_API_KEY: env.ELIZAOS_CLOUD_API_KEY ?? null,
    ELIZAOS_CLOUD_BASE_URL: env.ELIZAOS_CLOUD_BASE_URL ?? null,
    ELIZAOS_CLOUD_ENABLED: env.ELIZAOS_CLOUD_ENABLED ?? null,
    // Text models
    ELIZAOS_CLOUD_NANO_MODEL: env.ELIZAOS_CLOUD_NANO_MODEL ?? null,
    ELIZAOS_CLOUD_MEDIUM_MODEL: env.ELIZAOS_CLOUD_MEDIUM_MODEL ?? null,
    ELIZAOS_CLOUD_SMALL_MODEL: env.ELIZAOS_CLOUD_SMALL_MODEL ?? null,
    ELIZAOS_CLOUD_LARGE_MODEL: env.ELIZAOS_CLOUD_LARGE_MODEL ?? null,
    ELIZAOS_CLOUD_MEGA_MODEL: env.ELIZAOS_CLOUD_MEGA_MODEL ?? null,
    ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL ?? null,
    ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL: env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL ?? null,
    ELIZAOS_CLOUD_ACTION_PLANNER_MODEL: env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL ?? null,
    ELIZAOS_CLOUD_PLANNER_MODEL: env.ELIZAOS_CLOUD_PLANNER_MODEL ?? null,
    ELIZAOS_CLOUD_RESPONSE_MODEL: env.ELIZAOS_CLOUD_RESPONSE_MODEL ?? null,
    NANO_MODEL: env.NANO_MODEL ?? null,
    MEDIUM_MODEL: env.MEDIUM_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
    MEGA_MODEL: env.MEGA_MODEL ?? null,
    RESPONSE_HANDLER_MODEL: env.RESPONSE_HANDLER_MODEL ?? null,
    SHOULD_RESPOND_MODEL: env.SHOULD_RESPOND_MODEL ?? null,
    ACTION_PLANNER_MODEL: env.ACTION_PLANNER_MODEL ?? null,
    PLANNER_MODEL: env.PLANNER_MODEL ?? null,
    RESPONSE_MODEL: env.RESPONSE_MODEL ?? null,
    // Research model
    ELIZAOS_CLOUD_RESEARCH_MODEL: env.ELIZAOS_CLOUD_RESEARCH_MODEL ?? null,
    RESEARCH_MODEL: env.RESEARCH_MODEL ?? null,
    // Embedding
    ELIZAOS_CLOUD_EMBEDDING_MODEL: env.ELIZAOS_CLOUD_EMBEDDING_MODEL ?? null,
    ELIZAOS_CLOUD_EMBEDDING_API_KEY: env.ELIZAOS_CLOUD_EMBEDDING_API_KEY ?? null,
    ELIZAOS_CLOUD_EMBEDDING_URL: env.ELIZAOS_CLOUD_EMBEDDING_URL ?? null,
    ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: env.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS ?? null,
    // Image
    ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL: env.ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL ?? null,
    ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS:
      env.ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS ?? null,
    ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL: env.ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL ?? null,
    // Audio
    ELIZAOS_CLOUD_TTS_MODEL: env.ELIZAOS_CLOUD_TTS_MODEL ?? null,
    // Telemetry
    ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY: env.ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY ?? null,
  },

  async init(config, runtime) {
    // Initialize inference (OpenAI-compatible client)
    initializeOpenAI(config, runtime);
    // Chat-brain text handlers and embedding handlers are conditional (see
    // textInferenceModels/cloudEmbeddingModels above); other capability handlers
    // stay in the static `models` map below.
    registerTextInferenceModels(runtime);
    registerCloudEmbeddingModels(runtime);
  },

  // ─── Runtime Event Handlers ──────────────────────────────────────────
  // Forwards per-inference token + USD spend to waifu's burn meter when the
  // container is provisioned as a hosted waifu agent (inactive otherwise). See
  // utils/waifu-metering.ts for the honest-meter rationale.
  events: {
    MODEL_USED: [createWaifuMeteringHandler()],
  },

  // ─── Cloud Services ──────────────────────────────────────────────────
  // Services are registered in dependency order:
  //   1. CloudAuthService — must start first (other services depend on it)
  //   2. CloudBootstrapServiceImpl — pure trust-anchor accessor; no deps
  //   3. CloudManagedGatewayRelayService — optional local-runtime relay via shared cloud ingress
  //   4. CloudContainerService — needs auth to list/create containers
  //   5. CloudBridgeService — needs auth for WebSocket connections
  //   6. CloudBackupService — needs auth for snapshot API calls
  services: [
    CloudAuthService,
    CloudBootstrapServiceImpl,
    CloudManagedGatewayRelayService,
    CloudModelRegistryService,
    CloudContainerService,
    CloudBridgeService,
    CloudBackupService,
    // Bridges plugin-workflow's `workflow_credential_provider` slot to the
    // cloud's per-connector OAuth surface. Must start after CloudAuthService
    // because it reads the authenticated client via getService("CLOUD_AUTH").
    CloudCredentialProvider,
  ],

  // ─── Cloud Providers ─────────────────────────────────────────────────
  providers: [
    cloudStatusProvider,
    creditBalanceProvider,
    containerHealthProvider,
    modelRegistryProvider,
  ],

  // ─── Capability Model Handlers ───────────────────────────────────────
  // Always registered: these capabilities don't compete with BYO embedding or
  // chat-brain slots and must survive an external text provider. The chat-brain
  // text handlers (TEXT_*, RESPONSE_HANDLER, ACTION_PLANNER) and embedding
  // handlers are registered conditionally from init() — see textInferenceModels
  // and cloudEmbeddingModels above.
  models: {
    [ModelType.RESEARCH]: handleResearch,
    [ModelType.IMAGE]: handleImageGeneration,
    [ModelType.IMAGE_DESCRIPTION]: handleImageDescription,
    [ModelType.TEXT_TO_SPEECH]: handleTextToSpeech,
    [ModelType.TRANSCRIPTION]: handleTranscription,
    [ModelType.AUDIO]: handleAudioGeneration,
    [ModelType.VIDEO]: handleVideoGeneration,
  },

  tests: [
    {
      name: "ELIZAOS_CLOUD_plugin_tests",
      tests: [
        {
          name: "ELIZAOS_CLOUD_test_url_and_api_key_validation",
          fn: async (runtime: IAgentRuntime) => {
            const data = await createCloudApiClient(runtime).get<{
              data?: Array<Record<string, never>>;
            }>("/models");
            logger.log(
              {
                data: data.data?.length ?? "N/A",
              },
              "Models Available"
            );
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_text_embedding",
          fn: async (runtime: IAgentRuntime) => {
            const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
              text: "Hello, world!",
            });
            logger.log({ embedding }, "embedding");
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_text_large",
          fn: async (runtime: IAgentRuntime) => {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "What is the nature of reality in 10 words?",
            });
            if (text.length === 0) {
              throw new Error("Failed to generate text");
            }
            logger.log({ text }, "generated with test_text_large");
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_text_small",
          fn: async (runtime: IAgentRuntime) => {
            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "What is the nature of reality in 10 words?",
            });
            if (text.length === 0) {
              throw new Error("Failed to generate text");
            }
            logger.log({ text }, "generated with test_text_small");
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_image_generation",
          fn: async (runtime: IAgentRuntime) => {
            logger.log("ELIZAOS_CLOUD_test_image_generation");
            const image = await runtime.useModel(ModelType.IMAGE, {
              prompt: "A beautiful sunset over a calm ocean",
              count: 1,
              size: "1024x1024",
            });
            logger.log({ image }, "generated with test_image_generation");
          },
        },
        {
          name: "image-description",
          fn: async (runtime: IAgentRuntime) => {
            logger.log("ELIZAOS_CLOUD_test_image_description");
            const result = await runtime.useModel(
              ModelType.IMAGE_DESCRIPTION,
              "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg/537px-Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg"
            );

            if (
              result &&
              typeof result === "object" &&
              "title" in result &&
              "description" in result
            ) {
              logger.log({ result }, "Image description");
            } else {
              logger.error(`Invalid image description result format: ${JSON.stringify(result)}`);
            }
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_transcription",
          fn: async (runtime: IAgentRuntime) => {
            logger.log("ELIZAOS_CLOUD_test_transcription");
            const response = await fetch(
              "https://upload.wikimedia.org/wikipedia/en/4/40/Chris_Benoit_Voice_Message.ogg"
            );
            const arrayBuffer = await response.arrayBuffer();
            const transcription = await runtime.useModel(
              ModelType.TRANSCRIPTION,
              Buffer.from(new Uint8Array(arrayBuffer))
            );
            logger.log({ transcription }, "generated with test_transcription");
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_text_tokenizer_encode",
          fn: async (runtime: IAgentRuntime) => {
            const prompt = "Hello tokenizer encode!";
            const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
              prompt,
              modelType: ModelType.TEXT_SMALL,
            });
            if (!Array.isArray(tokens) || tokens.length === 0) {
              throw new Error("Failed to tokenize text: expected non-empty array of tokens");
            }
            logger.log({ tokens }, "Tokenized output");
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_text_tokenizer_decode",
          fn: async (runtime: IAgentRuntime) => {
            const prompt = "Hello tokenizer decode!";
            const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
              prompt,
              modelType: ModelType.TEXT_SMALL,
            });
            const decodedText = await runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, {
              tokens,
              modelType: ModelType.TEXT_SMALL,
            });
            if (decodedText !== prompt) {
              throw new Error(
                `Decoded text does not match original. Expected "${prompt}", got "${decodedText}"`
              );
            }
            logger.log({ decodedText }, "Decoded text");
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_text_to_speech",
          fn: async (runtime: IAgentRuntime) => {
            const response = await fetchTextToSpeech(runtime, {
              text: "Hello, this is a test for text-to-speech.",
            });
            if (!response) {
              throw new Error("Failed to generate speech");
            }
            logger.log("Generated speech successfully");
          },
        },
      ],
    },
  ],

  async dispose(runtime) {
    // Stop in reverse dependency order (auth last since others depend on it).
    await runtime.getService(CloudCredentialProvider.serviceType)?.stop();
    await runtime.getService(CloudBackupService.serviceType)?.stop();
    await runtime.getService(CloudBridgeService.serviceType)?.stop();
    await runtime.getService(CloudContainerService.serviceType)?.stop();
    await runtime.getService(CloudModelRegistryService.serviceType)?.stop();
    await runtime.getService(CloudManagedGatewayRelayService.serviceType)?.stop();
    await runtime.getService(CloudBootstrapServiceImpl.serviceType)?.stop();
    await runtime.getService(CloudAuthService.serviceType)?.stop();
  },
};

export default elizaOSCloudPlugin;

export { isCloudProvisionedContainer } from "./routes/cloud-provisioning";
export { handleCloudBillingRoute } from "./routes/cloud-billing-routes";
export { handleCloudCompatRoute } from "./routes/cloud-compat-routes";
export { handleCloudRelayRoute } from "./routes/cloud-relay-routes";
export {
  type CloudRouteState,
  handleCloudRoute,
} from "./routes/cloud-routes-autonomous";
export type { CloudConfigLike } from "./routes/cloud-routes-autonomous";
export { handleCloudStatusRoutes } from "./routes/cloud-status-routes";
export { runCloudSetup, type CloudSetupResult } from "./cloud-setup";
export { ClackObserver } from "./cloud/clack-observer";
export { NullCloudSetupObserver } from "./cloud/null-observer";
export type {
  AvailabilityResult,
  CloudSetupObserver,
  ConfirmPrompt,
  ProvisionSuccessInfo,
  SelectChoiceOption,
  SelectChoicePrompt,
} from "./cloud/setup-observer";
export { CloudManager, type CloudManagerCallbacks } from "./cloud/cloud-manager";
export {
  type CloudWalletDescriptor,
  type CloudWalletProvider,
  ElizaCloudClient,
} from "./cloud/bridge-client";
export {
  normalizeCloudSecret,
  resolveCloudApiKey,
} from "./cloud/cloud-api-key";
export {
  clearCloudSecrets,
  getCloudSecret,
  scrubCloudSecretsFromEnv,
} from "./lib/cloud-secrets";
export {
  __resetCloudBaseUrlCache,
  ensureCloudTtsApiKeyAlias,
  handleCloudTtsPreviewRoute,
  mirrorCompatHeaders,
  resolveCloudTtsBaseUrl,
  resolveElevenLabsApiKeyForCloudMode,
} from "./lib/server-cloud-tts";
export {
  fetchCloudVoiceCatalog,
  resetCloudVoiceCatalogCacheForTesting,
  setCloudVoiceClientFactoryForTesting,
  type CloudVoiceCatalogEntry,
  type CloudVoiceClient,
} from "./cloud-voice-catalog";
export {
  CloudTtsUnavailableError,
  type CloudTextToSpeechParams,
} from "./models/speech";
export {
  CloudSttUnavailableError,
  type CloudTranscriptionInput,
} from "./models/transcription";
export {
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
} from "./cloud/base-url";
export {
  isCloudAuthApiKeyService,
  normalizeCloudApiKey,
  type CloudAuthApiKeyService,
} from "./cloud/auth-service-types";
export { validateCloudBaseUrl } from "./cloud/validate-url";
export * from "./plugin";
export * from "./register-routes";
export * from "./cloud";
