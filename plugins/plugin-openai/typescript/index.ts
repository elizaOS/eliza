import type {
  TextToSpeechParams as CoreTextToSpeechParams,
  TranscriptionParams as CoreTranscriptionParams,
  DetokenizeTextParams,
  GenerateTextParams,
  IAgentRuntime,
  ImageDescriptionParams,
  ImageGenerationParams,
  JsonValue,
  ObjectGenerationParams,
  Plugin,
  ResearchParams,
  ResearchResult,
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
  handleResearch,
  handleTextEmbedding,
  handleTextLarge,
  handleTextSmall,
  handleTextToSpeech,
  handleTokenizerDecode,
  handleTokenizerEncode,
  handleTranscription,
} from "./models";
import type { ImageGenerationResult, OpenAIPluginConfig, TextStreamResult } from "./types";
import { getAuthHeader, getBaseURL } from "./utils/config";

type ProcessEnvLike = Record<string, string | undefined>;

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();

export const openaiPlugin: Plugin = {
  name: "openai",
  description: "OpenAI API integration for text, image, audio, and embedding models",

  config: {
    OPENAI_API_KEY: env.OPENAI_API_KEY ?? null,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL ?? null,
    OPENAI_SMALL_MODEL: env.OPENAI_SMALL_MODEL ?? null,
    OPENAI_LARGE_MODEL: env.OPENAI_LARGE_MODEL ?? null,
    SMALL_MODEL: env.SMALL_MODEL ?? null,
    LARGE_MODEL: env.LARGE_MODEL ?? null,
    OPENAI_EMBEDDING_MODEL: env.OPENAI_EMBEDDING_MODEL ?? null,
    OPENAI_EMBEDDING_API_KEY: env.OPENAI_EMBEDDING_API_KEY ?? null,
    OPENAI_EMBEDDING_URL: env.OPENAI_EMBEDDING_URL ?? null,
    OPENAI_EMBEDDING_DIMENSIONS: env.OPENAI_EMBEDDING_DIMENSIONS ?? null,
    OPENAI_IMAGE_DESCRIPTION_MODEL: env.OPENAI_IMAGE_DESCRIPTION_MODEL ?? null,
    OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS: env.OPENAI_IMAGE_DESCRIPTION_MAX_TOKENS ?? null,
    OPENAI_EXPERIMENTAL_TELEMETRY: env.OPENAI_EXPERIMENTAL_TELEMETRY ?? null,
    OPENAI_RESEARCH_MODEL: env.OPENAI_RESEARCH_MODEL ?? null,
    OPENAI_RESEARCH_TIMEOUT: env.OPENAI_RESEARCH_TIMEOUT ?? null,
  },

  async init(config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    initializeOpenAI(config as OpenAIPluginConfig | undefined, runtime);
  },

  models: {
    [ModelType.TEXT_EMBEDDING]: async (
      runtime: IAgentRuntime,
      params: TextEmbeddingParams | string | null
    ): Promise<number[]> => {
      return handleTextEmbedding(runtime, params);
    },

    [ModelType.TEXT_TOKENIZER_ENCODE]: async (
      runtime: IAgentRuntime,
      params: TokenizeTextParams
    ): Promise<number[]> => {
      return handleTokenizerEncode(runtime, params);
    },

    [ModelType.TEXT_TOKENIZER_DECODE]: async (
      runtime: IAgentRuntime,
      params: DetokenizeTextParams
    ): Promise<string> => {
      return handleTokenizerDecode(runtime, params);
    },

    [ModelType.TEXT_SMALL]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextSmall(runtime, params);
    },

    [ModelType.TEXT_LARGE]: async (
      runtime: IAgentRuntime,
      params: GenerateTextParams
    ): Promise<string | TextStreamResult> => {
      return handleTextLarge(runtime, params);
    },

    [ModelType.IMAGE]: async (
      runtime: IAgentRuntime,
      params: ImageGenerationParams
    ): Promise<ImageGenerationResult[]> => {
      return handleImageGeneration(runtime, params);
    },

    [ModelType.IMAGE_DESCRIPTION]: async (
      runtime: IAgentRuntime,
      params: ImageDescriptionParams | string
    ): Promise<{ title: string; description: string }> => {
      return handleImageDescription(runtime, params);
    },

    [ModelType.TRANSCRIPTION]: async (
      runtime: IAgentRuntime,
      input: CoreTranscriptionParams | Buffer | string
    ): Promise<string> => {
      return handleTranscription(runtime, input);
    },

    [ModelType.TEXT_TO_SPEECH]: async (
      runtime: IAgentRuntime,
      input: CoreTextToSpeechParams | string
    ): Promise<ArrayBuffer> => {
      return handleTextToSpeech(runtime, input);
    },

    [ModelType.OBJECT_SMALL]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams
    ): Promise<Record<string, JsonValue>> => {
      return handleObjectSmall(runtime, params);
    },

    [ModelType.OBJECT_LARGE]: async (
      runtime: IAgentRuntime,
      params: ObjectGenerationParams
    ): Promise<Record<string, JsonValue>> => {
      return handleObjectLarge(runtime, params);
    },

    [ModelType.RESEARCH]: async (
      runtime: IAgentRuntime,
      params: ResearchParams
    ): Promise<ResearchResult> => {
      return handleResearch(runtime, params);
    },
  },

  tests: [
    {
      name: "openai_plugin_tests",
      tests: [
        {
          name: "openai_test_api_connectivity",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const baseURL = getBaseURL(runtime);
            const response = await fetch(`${baseURL}/models`, {
              headers: getAuthHeader(runtime),
            });

            if (!response.ok) {
              throw new Error(
                `API connectivity test failed: ${response.status} ${response.statusText}`
              );
            }

            const data = (await response.json()) as { data?: unknown[] };
            logger.info(`[OpenAI Test] API connected. ${data.data?.length ?? 0} models available.`);
          },
        },
        {
          name: "openai_test_text_embedding",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const embedding = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
              text: "Hello, world!",
            });

            if (!Array.isArray(embedding) || embedding.length === 0) {
              throw new Error("Embedding should return a non-empty array");
            }

            logger.info(`[OpenAI Test] Generated embedding with ${embedding.length} dimensions`);
          },
        },
        {
          name: "openai_test_text_small",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const text = await runtime.useModel(ModelType.TEXT_SMALL, {
              prompt: "Say hello in exactly 5 words.",
            });

            if (typeof text !== "string" || text.length === 0) {
              throw new Error("TEXT_SMALL should return non-empty string");
            }

            logger.info(`[OpenAI Test] TEXT_SMALL generated: "${text.substring(0, 50)}..."`);
          },
        },
        {
          name: "openai_test_text_large",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const text = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "Explain quantum computing in 2 sentences.",
            });

            if (typeof text !== "string" || text.length === 0) {
              throw new Error("TEXT_LARGE should return non-empty string");
            }

            logger.info(`[OpenAI Test] TEXT_LARGE generated: "${text.substring(0, 50)}..."`);
          },
        },
        {
          name: "openai_test_tokenizer_roundtrip",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const originalText = "Hello, tokenizer test!";

            const tokens = await runtime.useModel(ModelType.TEXT_TOKENIZER_ENCODE, {
              prompt: originalText,
              modelType: ModelType.TEXT_SMALL,
            });

            if (!Array.isArray(tokens) || tokens.length === 0) {
              throw new Error("Tokenization should return non-empty token array");
            }

            const decodedText = await runtime.useModel(ModelType.TEXT_TOKENIZER_DECODE, {
              tokens,
              modelType: ModelType.TEXT_SMALL,
            });

            if (decodedText !== originalText) {
              throw new Error(
                `Tokenizer roundtrip failed: expected "${originalText}", got "${decodedText}"`
              );
            }

            logger.info(`[OpenAI Test] Tokenizer roundtrip successful (${tokens.length} tokens)`);
          },
        },
        {
          name: "openai_test_streaming",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const chunks: string[] = [];

            const result = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt: "Count from 1 to 5, one number per line.",
              stream: true,
              onStreamChunk: (chunk: string) => {
                chunks.push(chunk);
              },
            });

            if (typeof result !== "string" || result.length === 0) {
              throw new Error("Streaming should return non-empty result");
            }

            if (chunks.length === 0) {
              throw new Error("No streaming chunks received");
            }

            logger.info(`[OpenAI Test] Streaming test: ${chunks.length} chunks received`);
          },
        },
        {
          name: "openai_test_image_description",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const testImageUrl =
              "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/Camponotus_flavomarginatus_ant.jpg/440px-Camponotus_flavomarginatus_ant.jpg";

            const result = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, testImageUrl);

            if (
              !result ||
              typeof result !== "object" ||
              !("title" in result) ||
              !("description" in result)
            ) {
              throw new Error("Image description should return { title, description }");
            }

            logger.info(`[OpenAI Test] Image described: "${result.title}"`);
          },
        },
        {
          name: "openai_test_transcription",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            // Fetch a short audio sample
            const audioUrl =
              "https://upload.wikimedia.org/wikipedia/commons/2/25/En-Open_Source.ogg";

            const response = await fetch(audioUrl);
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = Buffer.from(new Uint8Array(arrayBuffer));

            const transcription = await runtime.useModel(ModelType.TRANSCRIPTION, audioBuffer);

            if (typeof transcription !== "string") {
              throw new Error("Transcription should return a string");
            }

            logger.info(`[OpenAI Test] Transcription: "${transcription.substring(0, 50)}..."`);
          },
        },
        {
          name: "openai_test_text_to_speech",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const audioData = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
              text: "Hello, this is a text-to-speech test.",
            });

            if (!(audioData instanceof ArrayBuffer) || audioData.byteLength === 0) {
              throw new Error("TTS should return non-empty ArrayBuffer");
            }

            logger.info(`[OpenAI Test] TTS generated ${audioData.byteLength} bytes of audio`);
          },
        },
        {
          name: "openai_test_object_generation",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            const result = await runtime.useModel(ModelType.OBJECT_SMALL, {
              prompt:
                "Return a JSON object with exactly these fields: name (string), age (number), active (boolean)",
            });

            if (!result || typeof result !== "object") {
              throw new Error("Object generation should return an object");
            }

            logger.info(
              `[OpenAI Test] Object generated: ${JSON.stringify(result).substring(0, 100)}`
            );
          },
        },
        {
          name: "openai_test_research",
          fn: async (runtime: IAgentRuntime): Promise<void> => {
            // Note: Deep research can take a long time (minutes to hours)
            // This test uses a simple query with maxToolCalls to limit execution time
            const result = await runtime.useModel(ModelType.RESEARCH, {
              input: "What is the current date and time?",
              tools: [{ type: "web_search_preview" }],
              maxToolCalls: 3, // Limit tool calls for faster test execution
            });

            if (!result || typeof result !== "object" || !("text" in result)) {
              throw new Error("Research should return an object with text property");
            }

            if (typeof result.text !== "string" || result.text.length === 0) {
              throw new Error("Research result text should be a non-empty string");
            }

            logger.info(
              `[OpenAI Test] Research completed. Text length: ${result.text.length}, Annotations: ${result.annotations?.length ?? 0}`
            );
          },
        },
      ],
    },
  ],
};

export default openaiPlugin;
