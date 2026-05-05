/**
 * Browser entry point for @elizaos/plugin-edge-tts
 *
 * Edge TTS is not available in browser environments because it requires
 * Node.js file system access and WebSocket connections that browsers don't support.
 *
 * For browser TTS, use @elizaos/plugin-elevenlabs or @elizaos/plugin-openai instead.
 */
import { logger, type Plugin } from "@elizaos/core";

export const edgeTTSPlugin: Plugin = {
  name: "edge-tts",
  description: "Edge TTS plugin (browser stub - not available in browser environments)",
  models: {},
  tests: [],
};

// Log warning when imported in browser
if (typeof window !== "undefined") {
  logger.warn(
    "[EdgeTTS] Edge TTS is not available in browser environments. " +
      "Use @elizaos/plugin-elevenlabs or @elizaos/plugin-openai for browser TTS."
  );
}

export default edgeTTSPlugin;
