/**
 * Browser entry point for @elizaos/plugin-elizacloud
 * 
 * This entry point excludes database-related exports that require Node.js.
 * For database/schema access, use the /node entry point instead.
 */

import type { IAgentRuntime, Plugin, IDatabaseAdapter } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { initializeOpenAI } from "./init";
import {
  handleTextSmall,
  handleTextLarge,
  handleObjectSmall,
  handleObjectLarge,
  handleTextEmbedding,
  handleImageGeneration,
  handleImageDescription,
  handleTranscription,
  handleTextToSpeech,
  handleTokenizerEncode,
  handleTokenizerDecode,
  fetchTextToSpeech,
} from "./models";
import { getApiKey, getBaseURL, isBrowser } from "./utils/config";

// Re-export types for convenience
export type {
  OpenAITranscriptionParams,
  OpenAITextToSpeechParams,
} from "./types";

// Note: Database and storage exports are NOT available in the browser build.
// Use @elizaos/plugin-elizacloud/node for database access.
export type { CloudDatabaseConfig, CloudDatabaseStatus } from "./database/types";

/**
 * ElizaOS Cloud Plugin - Browser version
 * 
 * This version excludes database functionality which requires Node.js.
 */
export const elizaOSCloudPlugin: Plugin = {
  name: "elizaOSCloud",
  description:
    "ElizaOS Cloud plugin (browser) - Multi-model inference (GPT-4, Claude, Gemini), embeddings, image generation, transcription, TTS. Database features require Node.js runtime.",
  config: {
    ELIZAOS_CLOUD_API_KEY: process.env.ELIZAOS_CLOUD_API_KEY,
    ELIZAOS_CLOUD_BASE_URL: process.env.ELIZAOS_CLOUD_BASE_URL,
    ELIZAOS_CLOUD_SMALL_MODEL: process.env.ELIZAOS_CLOUD_SMALL_MODEL,
    ELIZAOS_CLOUD_LARGE_MODEL: process.env.ELIZAOS_CLOUD_LARGE_MODEL,
    SMALL_MODEL: process.env.SMALL_MODEL,
    LARGE_MODEL: process.env.LARGE_MODEL,
    ELIZAOS_CLOUD_EMBEDDING_MODEL: process.env.ELIZAOS_CLOUD_EMBEDDING_MODEL,
    ELIZAOS_CLOUD_EMBEDDING_API_KEY: process.env.ELIZAOS_CLOUD_EMBEDDING_API_KEY,
    ELIZAOS_CLOUD_EMBEDDING_URL: process.env.ELIZAOS_CLOUD_EMBEDDING_URL,
    ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: process.env.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS,
    ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL: process.env.ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL,
    ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS: process.env.ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS,
    ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL: process.env.ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL,
    ELIZAOS_CLOUD_TTS_MODEL: process.env.ELIZAOS_CLOUD_TTS_MODEL,
    ELIZAOS_CLOUD_TTS_VOICE: process.env.ELIZAOS_CLOUD_TTS_VOICE,
    ELIZAOS_CLOUD_TRANSCRIPTION_MODEL: process.env.ELIZAOS_CLOUD_TRANSCRIPTION_MODEL,
    ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY: process.env.ELIZAOS_CLOUD_EXPERIMENTAL_TELEMETRY,
  },
  priority: -1,
  async init(config, runtime) {
    initializeOpenAI(config, runtime);
  },
  models: {
    [ModelType.TEXT_SMALL]: handleTextSmall,
    [ModelType.TEXT_LARGE]: handleTextLarge,
    [ModelType.TEXT_REASONING_SMALL]: handleTextSmall,
    [ModelType.TEXT_REASONING_LARGE]: handleTextLarge,
    [ModelType.OBJECT_SMALL]: handleObjectSmall,
    [ModelType.OBJECT_LARGE]: handleObjectLarge,
    [ModelType.TEXT_EMBEDDING]: handleTextEmbedding,
    [ModelType.TEXT_TOKENIZER_ENCODE]: handleTokenizerEncode,
    [ModelType.TEXT_TOKENIZER_DECODE]: handleTokenizerDecode,
    [ModelType.IMAGE]: handleImageGeneration,
    [ModelType.IMAGE_DESCRIPTION]: handleImageDescription,
    [ModelType.TRANSCRIPTION]: handleTranscription,
    [ModelType.TEXT_TO_SPEECH]: handleTextToSpeech,
  },
};

export default elizaOSCloudPlugin;
