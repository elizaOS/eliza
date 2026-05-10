/**
 * Google Chat Plugin for ElizaOS
 *
 * Provides Google Chat messaging integration for ElizaOS agents,
 * supporting spaces, direct messages, threads, and reactions.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { createGoogleChatConnectorAccountProvider } from "./connector-account-provider.js";
import { GoogleChatService } from "./service.js";
import { GoogleChatWorkflowCredentialProvider } from "./workflow-credential-provider.js";

export * from "./accounts.js";
// Message, space listing, and reaction operations route through MESSAGE via
// the MessageConnector registered by GoogleChatService.
// Export types
export * from "./types.js";
// Export service
export { GoogleChatService };

/**
 * Google Chat plugin definition
 */
const googleChatPlugin: Plugin = {
  name: "google-chat",
  description: "Google Chat integration plugin for ElizaOS agents",

  services: [GoogleChatService, GoogleChatWorkflowCredentialProvider],

  actions: [],

  providers: [],

  tests: [],

  // Self-declared auto-enable: activate when the "googlechat" connector is
  // configured under config.connectors. The hardcoded CONNECTOR_PLUGINS map
  // in plugin-auto-enable-engine.ts still serves as a fallback.
  autoEnable: {
    connectorKeys: ["googlechat"],
  },

  /**
   * Plugin initialization hook
   */
  init: async (config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    logger.info("Initializing Google Chat plugin...");

    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createGoogleChatConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:google-chat",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Google Chat provider with ConnectorAccountManager"
      );
    }

    // Log configuration status
    const serviceAccount =
      config.GOOGLE_CHAT_SERVICE_ACCOUNT || process.env.GOOGLE_CHAT_SERVICE_ACCOUNT;
    const serviceAccountFile =
      config.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_FILE;
    const hasCredentials = Boolean(
      serviceAccount || serviceAccountFile || process.env.GOOGLE_APPLICATION_CREDENTIALS
    );

    logger.info(`Google Chat plugin configuration:`);
    logger.info(`  - Credentials configured: ${hasCredentials ? "Yes" : "No"}`);
    logger.info(
      `  - Audience type: ${config.GOOGLE_CHAT_AUDIENCE_TYPE || process.env.GOOGLE_CHAT_AUDIENCE_TYPE || "(not set)"}`
    );
    logger.info(
      `  - Audience: ${config.GOOGLE_CHAT_AUDIENCE || process.env.GOOGLE_CHAT_AUDIENCE ? "(set)" : "(not set)"}`
    );
    logger.info(
      `  - Webhook path: ${config.GOOGLE_CHAT_WEBHOOK_PATH || process.env.GOOGLE_CHAT_WEBHOOK_PATH || "/googlechat"}`
    );

    if (!hasCredentials) {
      logger.warn(
        "Google Chat service account credentials not configured. " +
          "Set GOOGLE_CHAT_SERVICE_ACCOUNT, GOOGLE_CHAT_SERVICE_ACCOUNT_FILE, or GOOGLE_APPLICATION_CREDENTIALS."
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
