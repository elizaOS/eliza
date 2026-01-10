import type {
  DetokenizeTextParams,
  GenerateTextParams,
  IAgentRuntime,
  ImageDescriptionParams,
  ObjectGenerationParams,
  Plugin,
  TextEmbeddingParams,
  TokenizeTextParams,
} from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { initializeOpenAI } from "./init";
import {
  handleImageDescription,
  handleImageGeneration,
  handleObjectLarge,
  handleObjectSmall,
  handleTextEmbedding,
  handleTextLarge,
  handleTextSmall,
  handleTextToSpeech,
  handleTokenizerDecode,
  handleTokenizerEncode,
  handleTranscription,
} from "./models";
import { getAuthHeader, getBaseURL } from "./utils/config";

export * from "./types";

/**
 * Defines the OpenAI plugin with its name, description, and configuration options.
 * @type {Plugin}
 */
export const openaiPlugin: Plugin = {
  name: "openai",
  description: "OpenAI plugin",
  config: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? null,
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? null,
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? null,
    SMALL_MODEL: process.env.SMALL_MODEL ?? null,
    LARGE_MODEL: process.env.LARGE_MODEL ?? null,
    OPENAI_EMBEDDING_MODEL: process.env.OPENAI_EMBEDDING_MODEL ?? null,
    OPENAI_EMBEDDING_API_KEY: process.env.OPENAI_EMBEDDING_API_KEY ?? null,
    OPENAI_EMBEDDING_URL: process.env.OPENAI_EMBEDDING_URL ?? null,
    OPENAI_EMBEDDING_DIMENSIONS: process.env.OPENAI_EMBEDDING_DIMENSIONS ?? null,
    OPENAI_IMAGE_DESCRIPTION_MODEL: process.env.OPENAI_IMAGE_DESCRIPTION_MODEL ?? null,
    OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS:
      process.env.OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS ?? null,
    OPENAI_EXPERIMENTAL_TELEMETRY: process.env.OPENAI_EXPERIMENTAL_TELEMETRY ?? null,
  },
  async init(_config, runtime) {
    // Note: We intentionally don't await here because elizaOS expects
    // the init method to return quickly. The initializeOpenAI function
    // performs background validation and logging.
    initializeOpenAI(_config, runtime);
  },

  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null,
    ) => {
      return handleTextEmbedding(runtime, params);
    },
    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      runtime: IAgentRuntime,
      params: TokenizeTextParams,
    ) => {
      return handleTokenizerEncode(runtime, params);
    },
    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      runtime: IAgentRuntime,
      params: DetokenizeTextParams,
    ) => {
      return handleTokenizerDecode(runtime, params);
    },
    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ) => {
      return handleTextSmall(runtime, params);
    },
    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ) => {
      return handleTextLarge(runtime, params);
    },
    [ModelType.IMAGE]: async (
      runtime: IAgentRuntime,
      params: {
        prompt: string;
        n?: number;
        size?: string;
      },
    ) => {
      return handleImageGeneration(runtime, params);
    },
    [ModelType.IMAGE_DESCRIPTION]: async (
      runtime: IAgentRuntime,
      params: ImageDescriptionParams | string,
    ) => {
      return handleImageDescription(runtime, params);
    },
    [ModelType.TRANSCRIPTION]: async (
      runtime: IAgentRuntime,
      input: Blob | File | Buffer | any,
    ) => {
      return handleTranscription(runtime, input);
    },
    [ModelType.TEXT_TO_SPEECH]: async (
      runtime: IAgentRuntime,
      input: string | any,
    ) => {
      return handleTextToSpeech(runtime, input);
    },
    [ModelType.OBJECT_SMALL]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams,
    ) => {
      return handleObjectSmall(runtime, params);
    },
    [ModelType.OBJECT_LARGE]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams,
    ) => {
      return handleObjectLarge(runtime, params);
    },
  },
  tests: [
    {
      name: "openai_plugin_tests",
      tests: [
        {
          name: "openai_test_url_and_api_key_validation",
          fn: async (runtime: IAgentRuntime) => {
            const baseURL = getBaseURL(runtime);
            const response = await fetch(`${baseURL}/models`, {
              headers: getAuthHeader(runtime),
            });
            const data = await response.json();
            logger.log(
              { data: (data as { data?: unknown[] })?.data?.length ?? "N/A" },
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
          name: "openai_test_text_embedding",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const embedding = await runtime.useModel(
                ModelType.TEXT_EMBEDDING,
                {
                  text: "Hello, world!",
                },
              );
              logger.log({ embedding }, "embedding");
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_embedding: ${message}`);
              throw error;
            }
          },
        },
        {
          name: "openai_test_text_large",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: "What is the nature of reality in 10 words?",
              });
              if (text.length === 0) {
                throw new Error("Failed to generate text");
              }
              logger.log({ text }, "generated with test_text_large");
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_large: ${message}`);
              throw error;
            }
          },
        },
        {
          name: "openai_test_text_small",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const text = await runtime.useModel(ModelType.TEXT_SMALL, {
                prompt: "What is the nature of reality in 10 words?",
              });
              if (text.length === 0) {
                throw new Error("Failed to generate text");
              }
              logger.log({ text }, "generated with test_text_small");
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_text_small: ${message}`);
              throw error;
            }
          },
        },
        {
          name: "openai_test_image_generation",
          fn: async (runtime: IAgentRuntime) => {
            logger.log("openai_test_image_generation");
            try {
              const image = await runtime.useModel(ModelType.IMAGE, {
                prompt: "A beautiful sunset over a calm ocean",
                count: 1,
                size: "1024x1024",
              });
              logger.log({ image }, "generated with test_image_generation");
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_image_generation: ${message}`);
              throw error;
            }
          },
        },
        {
          name: "image-description",
          fn: async (runtime: IAgentRuntime) => {
            try {
              logger.log("openai_test_image_description");
              try {
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
                    "Invalid image description result format:",
                    result,
                  );
                }
              } catch (e: unknown) {
                const message = e instanceof Error ? e.message : String(e);
                logger.error(`Error in image description test: ${message}`);
              }
            } catch (e: unknown) {
              const message = e instanceof Error ? e.message : String(e);
              logger.error(
                `Error in openai_test_image_description: ${message}`,
              );
            }
          },
        },
        {
          name: "openai_test_transcription",
          fn: async (runtime: IAgentRuntime) => {
            logger.log("openai_test_transcription");
            try {
              const response = await fetch(
                "https://upload.wikimedia.org/wikipedia/en/4/40/Chris_Benoit_Voice_Message.ogg",
              );
              const arrayBuffer = await response.arrayBuffer();
              const transcription = await runtime.useModel(
                ModelType.TRANSCRIPTION,
                Buffer.from(new Uint8Array(arrayBuffer)),
              );
              logger.log(
                { transcription },
                "generated with test_transcription",
              );
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger.error(`Error in test_transcription: ${message}`);
              throw error;
            }
          },
        },
        {
          name: "openai_test_text_tokenizer_encode",
          fn: async (runtime: IAgentRuntime) => {
            const prompt = "Hello tokenizer encode!";
            const tokens = await runtime.useModel(
              ModelType.TEXT_TOKENIZER_ENCODE,
              { prompt, modelType: ModelType.TEXT_SMALL },
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
          name: "openai_test_text_tokenizer_decode",
          fn: async (runtime: IAgentRuntime) => {
            const prompt = "Hello tokenizer decode!";
            const tokens = await runtime.useModel(
              ModelType.TEXT_TOKENIZER_ENCODE,
              { prompt, modelType: ModelType.TEXT_SMALL },
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
          name: "openai_test_text_to_speech",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const response = await runtime.useModel(
                ModelType.TEXT_TO_SPEECH,
                {
                  text: "Hello, this is a test for text-to-speech.",
                },
              );
              if (!response) {
                throw new Error("Failed to generate speech");
              }
              logger.log("Generated speech successfully");
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger.error(`Error in openai_test_text_to_speech: ${message}`);
              throw error;
            }
          },
        },
        {
          name: "openai_test_text_generation_large",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const result = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: "Say hello in 5 words.",
              });
              if (!result || result.length === 0) {
                throw new Error("Text generation returned empty result");
              }
              logger.log({ result }, "Text generation test completed");
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger.error(
                `Error in openai_test_text_generation_large: ${message}`,
              );
              throw error;
            }
          },
        },
        {
          name: "openai_test_streaming",
          fn: async (runtime: IAgentRuntime) => {
            try {
              const chunks: string[] = [];
              const result = await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: "Count from 1 to 5.",
                onStreamChunk: (chunk: string) => {
                  chunks.push(chunk);
                },
              });
              if (!result || result.length === 0) {
                throw new Error("Streaming returned empty result");
              }
              if (chunks.length === 0) {
                throw new Error("No streaming chunks received");
              }
              logger.log(
                { chunks: chunks.length, result: result.substring(0, 50) },
                "Streaming test completed",
              );
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : String(error);
              logger.error(`Error in openai_test_streaming: ${message}`);
              throw error;
            }
          },
        },
      ],
    },
  ],
};

export default openaiPlugin;
