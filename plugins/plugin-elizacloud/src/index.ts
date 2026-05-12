import type { IAgentRuntime, Plugin } from "@elizaos/core";
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
  handleResearch,
  handleResponseHandler,
  handleTextEmbedding,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
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
import { createCloudApiClient } from "./utils/sdk-client";

const TEXT_NANO_MODEL_TYPE = (ModelType.TEXT_NANO ?? "TEXT_NANO") as string;
const TEXT_MEDIUM_MODEL_TYPE = (ModelType.TEXT_MEDIUM ?? "TEXT_MEDIUM") as string;
const TEXT_MEGA_MODEL_TYPE = (ModelType.TEXT_MEGA ?? "TEXT_MEGA") as string;
const RESPONSE_HANDLER_MODEL_TYPE = (ModelType.RESPONSE_HANDLER ?? "RESPONSE_HANDLER") as string;
const ACTION_PLANNER_MODEL_TYPE = (ModelType.ACTION_PLANNER ?? "ACTION_PLANNER") as string;

type ProcessEnvLike = Record<string, string | undefined>;

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();

export const elizaOSCloudPlugin: Plugin = {
  name: "elizaOSCloud",
  description:
    "ElizaOS Cloud plugin — Multi-model AI generation, container provisioning, agent bridge, and billing management",
  autoEnable: {
    envKeys: ["ELIZAOS_CLOUD_API_KEY", "ELIZAOS_CLOUD_ENABLED"],
  },

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
    ELIZAOS_CLOUD_TRANSCRIPTION_MODEL: env.ELIZAOS_CLOUD_TRANSCRIPTION_MODEL ?? null,
    // Telemetry
    ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY: env.ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY ?? null,
  },

  async init(config, runtime) {
    // Initialize inference (OpenAI-compatible client)
    initializeOpenAI(config, runtime);
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

  // ─── Inference Model Handlers ────────────────────────────────────────
  models: {
    [ModelType.TEXT_EMBEDDING]: handleTextEmbedding,
    [TEXT_NANO_MODEL_TYPE]: handleTextNano,
    [TEXT_MEDIUM_MODEL_TYPE]: handleTextMedium,
    [ModelType.TEXT_SMALL]: handleTextSmall,
    [ModelType.TEXT_LARGE]: handleTextLarge,
    [TEXT_MEGA_MODEL_TYPE]: handleTextMega,
    [RESPONSE_HANDLER_MODEL_TYPE]: handleResponseHandler,
    [ACTION_PLANNER_MODEL_TYPE]: handleActionPlanner,
    [ModelType.RESEARCH]: handleResearch,
    [ModelType.IMAGE]: handleImageGeneration,
    [ModelType.IMAGE_DESCRIPTION]: handleImageDescription,
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
export { runCloudOnboarding, type CloudOnboardingResult } from "./onboarding";
export { ClackObserver } from "./cloud/clack-observer";
export { NullCloudOnboardingObserver } from "./cloud/null-observer";
export type {
  AvailabilityResult,
  CloudOnboardingObserver,
  ConfirmPrompt,
  ProvisionSuccessInfo,
  SelectChoiceOption,
  SelectChoicePrompt,
} from "./cloud/onboarding-observer";
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
  normalizeCloudSiteUrl,
  resolveCloudApiBaseUrl,
} from "./cloud/base-url";
export { validateCloudBaseUrl } from "./cloud/validate-url";
export * from "./plugin";
export * from "./register-routes";
export * from "./cloud";
