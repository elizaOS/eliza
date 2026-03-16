/**
 * Google Chat Plugin for elizaOS
 *
 * Provides Google Chat messaging integration for elizaOS agents,
 * supporting spaces, direct messages, threads, and reactions.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { listSpaces, sendMessage, sendReaction } from "./actions/index.js";
import { spaceStateProvider, userContextProvider } from "./providers/index.js";
import { GoogleChatService } from "./service.js";

// Export types
export * from "./types.js";

// Export service
export { GoogleChatService };

// Export actions
export { sendMessage, sendReaction, listSpaces };

// Export providers
export { spaceStateProvider, userContextProvider };

/**
 * Google Chat plugin definition
 */
const googleChatPlugin: Plugin = {
  name: "google-chat",
  description: "Google Chat integration plugin for elizaOS agents",

  services: [GoogleChatService],

  actions: [sendMessage, sendReaction, listSpaces],

  providers: [spaceStateProvider, userContextProvider],

  tests: [],

  /**
   * Plugin initialization hook
   */
  init: async (
    config: Record<string, string>,
    _runtime: IAgentRuntime,
  ): Promise<void> => {
    logger.info("Initializing Google Chat plugin...");

    // Log configuration status
    const serviceAccount =
      config.GOOGLE_CHAT_SERVICE_ACCOUNT ||
      process.env.GOOGLE_CHAT_SERVICE_ACCOUNT;
    const serviceAccountFile =
      config.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE ||
      process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE;
    const hasCredentials = Boolean(
      serviceAccount ||
        serviceAccountFile ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS,
    );

    logger.info(`Google Chat plugin configuration:`);
    logger.info(`  - Credentials configured: ${hasCredentials ? "Yes" : "No"}`);
    logger.info(
      `  - Audience type: ${config.GOOGLE_CHAT_AUDIENCE_TYPE || process.env.GOOGLE_CHAT_AUDIENCE_TYPE || "(not set)"}`,
    );
    logger.info(
      `  - Audience: ${config.GOOGLE_CHAT_AUDIENCE || process.env.GOOGLE_CHAT_AUDIENCE ? "(set)" : "(not set)"}`,
    );
    logger.info(
      `  - Webhook path: ${config.GOOGLE_CHAT_WEBHOOK_PATH || process.env.GOOGLE_CHAT_WEBHOOK_PATH || "/googlechat"}`,
    );

    if (!hasCredentials) {
      logger.warn(
        "Google Chat service account credentials not configured. " +
          "Set GOOGLE_CHAT_SERVICE_ACCOUNT, GOOGLE_CHAT_SERVICE_ACCOUNT_FILE, or GOOGLE_APPLICATION_CREDENTIALS.",
      );
    }

    logger.info("Google Chat plugin initialized");
  },
};

export default googleChatPlugin;

// Channel configuration types
export type {
  GoogleChatAccountConfig,
  GoogleChatActionConfig,
  GoogleChatConfig,
  GoogleChatReactionNotificationMode,
  GoogleChatSpaceConfig,
} from "./config.js";
