/**
 * @fileoverview MiniMax Provider Plugin for ElizaOS
 *
 * Provides MiniMax AI model support including:
 * - Chat completion (MiniMax-M2.5 and MiniMax-M2.5-highspeed)
 * - Text-to-Speech (speech-2.8-hd and speech-2.8-turbo)
 *
 * MiniMax API is OpenAI-compatible, using the base URL https://api.minimax.io/v1
 *
 * @see https://platform.minimax.io/docs
 */

import type { Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  handleTextSmall,
  handleTextLarge,
  handleObjectSmall,
  handleObjectLarge,
} from "./chat";
import { handleTextToSpeech } from "./tts";

/**
 * MiniMax provider plugin for ElizaOS.
 *
 * Registers model handlers for text generation (TEXT_SMALL, TEXT_LARGE),
 * structured output (OBJECT_SMALL, OBJECT_LARGE), and text-to-speech
 * using MiniMax's API.
 *
 * Required environment variable: MINIMAX_API_KEY
 * Optional: MINIMAX_BASE_URL (defaults to https://api.minimax.io/v1)
 */
const minimaxPlugin: Plugin = {
  name: "minimax",
  description:
    "MiniMax AI provider plugin - Chat completion (MiniMax-M2.5) and TTS (speech-2.8-hd)",
  models: {
    TEXT_SMALL: handleTextSmall,
    TEXT_LARGE: handleTextLarge,
    OBJECT_SMALL: handleObjectSmall,
    OBJECT_LARGE: handleObjectLarge,
    TEXT_TO_SPEECH: handleTextToSpeech,
  },
  init: async (_config, runtime) => {
    const apiKey =
      runtime.getSetting("MINIMAX_API_KEY") ||
      process.env.MINIMAX_API_KEY;

    if (!apiKey) {
      logger.warn(
        "MiniMax plugin initialized without MINIMAX_API_KEY - API calls will fail"
      );
    } else {
      logger.info("MiniMax plugin initialized successfully");
    }
  },
};

export default minimaxPlugin;
