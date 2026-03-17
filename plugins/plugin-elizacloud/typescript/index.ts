import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { checkCloudCreditsAction } from "./actions/check-credits";
import { freezeCloudAgentAction } from "./actions/freeze-agent";
// Cloud actions
import { provisionCloudAgentAction } from "./actions/provision-agent";
import { resumeCloudAgentAction } from "./actions/resume-agent";
// Cloud providers
import { cloudStatusProvider } from "./cloud-providers/cloud-status";
import { containerHealthProvider } from "./cloud-providers/container-health";
import { creditBalanceProvider } from "./cloud-providers/credit-balance";
import { initializeOpenAI } from "./init";
import {
  fetchTextToSpeech,
  handleImageDescription,
  handleImageGeneration,
  handleObjectLarge,
  handleObjectSmall,
  handleTextEmbedding,
  handleTextLarge,
  handleTextSmall,
} from "./models";
// Cloud services
import { CloudAuthService } from "./services/cloud-auth";
import { CloudBackupService } from "./services/cloud-backup";
import { CloudBridgeService } from "./services/cloud-bridge";
import { CloudContainerService } from "./services/cloud-container";
import { getApiKey, getBaseURL } from "./utils/config";

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
    "elizaOS Cloud plugin — Multi-model AI generation, container provisioning, agent bridge, and billing management",

  config: {
    ELIZAOS_CLOUD_API_KEY: env.ELIZAOS_CLOUD_API_KEY ?? null,
    ELIZAOS_CLOUD_BASE_URL: env.ELIZAOS_CLOUD_BASE_URL ?? null,
    ELIZAOS_CLOUD_ENABLED: env.ELIZAOS_CLOUD_ENABLED ?? null,
    ELIZAOS_CLOUD_SMALL_MODEL: env.ELIZAOS_CLOUD_SMALL_MODEL ?? null,
    ELIZAOS_CLOUD_LARGE_MODEL: env.ELIZAOS_CLOUD_LARGE_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
    ELIZAOS_CLOUD_EMBEDDING_MODEL: env.ELIZAOS_CLOUD_EMBEDDING_MODEL ?? null,
    ELIZAOS_CLOUD_EMBEDDING_API_KEY:
      env.ELIZAOS_CLOUD_EMBEDDING_API_KEY ?? null,
    ELIZAOS_CLOUD_EMBEDDING_URL: env.ELIZAOS_CLOUD_EMBEDDING_URL ?? null,
    ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS:
      env.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS ?? null,
    ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL:
      env.ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL ?? null,
    ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS:
      env.ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS ?? null,
    ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY:
      env.ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY ?? null,
    ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL:
      env.ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL ?? null,
  },

  async init(
    config: Record<string, string | number | boolean | null>,
    runtime: IAgentRuntime,
  ) {
    // Initialize inference (OpenAI-compatible client)
    initializeOpenAI(config as Record<string, string | null>, runtime);
  },

  // ─── Cloud Services ──────────────────────────────────────────────────
  // Services are registered in dependency order:
  //   1. CloudAuthService — must start first (other services depend on it)
  //   2. CloudContainerService — needs auth to list/create containers
  //   3. CloudBridgeService — needs auth for WebSocket connections
  //   4. CloudBackupService — needs auth for snapshot API calls
  services: [
    CloudAuthService,
    CloudContainerService,
    CloudBridgeService,
    CloudBackupService,
  ],

  // ─── Cloud Actions ───────────────────────────────────────────────────
  actions: [
    provisionCloudAgentAction,
    freezeCloudAgentAction,
    resumeCloudAgentAction,
    checkCloudCreditsAction,
  ],

  // ─── Cloud Providers ─────────────────────────────────────────────────
  providers: [
    cloudStatusProvider,
    creditBalanceProvider,
    containerHealthProvider,
  ],

  // ─── Inference Model Handlers ────────────────────────────────────────
  models: {
    [ModelType.TEXT_EMBEDDING]: handleTextEmbedding,
    [ModelType.TEXT_SMALL]: handleTextSmall,
    [ModelType.TEXT_LARGE]: handleTextLarge,
    [ModelType.IMAGE]: handleImageGeneration,
    [ModelType.IMAGE_DESCRIPTION]: handleImageDescription,
    [ModelType.OBJECT_SMALL]: handleObjectSmall,
    [ModelType.OBJECT_LARGE]: handleObjectLarge,
  },

  tests: [
    {
      name: "ELIZAOS_CLOUD_plugin_tests",
      tests: [
        {
          name: "ELIZAOS_CLOUD_test_url_and_api_key_validation",
          fn: async (runtime: IAgentRuntime) => {
            const baseURL = getBaseURL(runtime);
            const response = await fetch(`${baseURL}/models`, {
              headers: {
                Authorization: `Bearer ${getApiKey(runtime)}`,
              },
            });
            const data = await response.json();
            logger.log(
              {
                data:
                  (data as { data?: Array<Record<string, never>> })?.data
                    ?.length ?? "N/A",
              },
              "Models Available",
            );
            if (!response.ok) {
              throw new Error(
                `Failed to validate OpenAI API key: ${response.statusText}`,
              );
            }
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
            const text = (await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "What is the nature of reality in 10 words?",
            })) as string;
            if (text.length === 0) {
              throw new Error("Failed to generate text");
            }
            logger.log({ text }, "generated with test_text_large");
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_text_small",
          fn: async (runtime: IAgentRuntime) => {
            const text = (await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "What is the nature of reality in 10 words?",
            })) as string;
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
              "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg/537px-Vitalik_Buterin_TechCrunch_London_2015_%28cropped%29.jpg",
            );

            if (
              result &&
              typeof result === "object" &&
              "title" in result &&
              "description" in result
            ) {
              logger.log({ result }, "Image description");
            } else {
              logger.error(
                `Invalid image description result format: ${JSON.stringify(result)}`,
              );
            }
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_transcription",
          fn: async (runtime: IAgentRuntime) => {
            logger.log("ELIZAOS_CLOUD_test_transcription");
            const response = await fetch(
              "https://upload.wikimedia.org/wikipedia/en/4/40/Chris_Benoit_Voice_Message.ogg",
            );
            const arrayBuffer = await response.arrayBuffer();
            const transcription = await runtime.useModel(
              ModelType.TRANSCRIPTION,
              Buffer.from(new Uint8Array(arrayBuffer)),
            );
            logger.log({ transcription }, "generated with test_transcription");
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_text_tokenizer_encode",
          fn: async (runtime: IAgentRuntime) => {
            const prompt = "Hello tokenizer encode!";
            const tokens = await runtime.useModel(
              ModelType.TEXT_TOKENIZER_ENCODE,
              {
                prompt,
                modelType: ModelType.TEXT_SMALL,
              },
            );
            if (!Array.isArray(tokens) || tokens.length === 0) {
              throw new Error(
                "Failed to tokenize text: expected non-empty array of tokens",
              );
            }
            logger.log({ tokens }, "Tokenized output");
          },
        },
        {
          name: "ELIZAOS_CLOUD_test_text_tokenizer_decode",
          fn: async (runtime: IAgentRuntime) => {
            const prompt = "Hello tokenizer decode!";
            const tokens = await runtime.useModel(
              ModelType.TEXT_TOKENIZER_ENCODE,
              {
                prompt,
                modelType: ModelType.TEXT_SMALL,
              },
            );
            const decodedText = await runtime.useModel(
              ModelType.TEXT_TOKENIZER_DECODE,
              {
                tokens,
                modelType: ModelType.TEXT_SMALL,
              },
            );
            if (decodedText !== prompt) {
              throw new Error(
                `Decoded text does not match original. Expected "${prompt}", got "${decodedText}"`,
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
