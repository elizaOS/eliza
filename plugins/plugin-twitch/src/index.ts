/**
 * Twitch chat integration plugin for ElizaOS.
 *
 * This plugin provides Twitch chat integration using the @twurple library.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

export * from "./accounts.js";
// Service
export { TwitchService } from "./service.js";
// Types
export * from "./types.js";

// Twitch send/list/join/leave operations route through the MESSAGE action via
// the MessageConnector registered by TwitchService.registerSendHandlers.

import { userContextProvider } from "./providers/userContext.js";

export { userContextProvider };

// Import service for plugin
import { TwitchService } from "./service.js";

/**
 * Twitch plugin definition.
 */
const twitchPlugin: Plugin = {
  name: "twitch",
  description:
    "Twitch chat integration plugin for ElizaOS with real-time messaging",

  services: [TwitchService],

  actions: [],

  providers: [userContextProvider],

  tests: [],

  init: async (
    _config: Record<string, string>,
    runtime: IAgentRuntime,
  ): Promise<void> => {
    const username = runtime.getSetting("TWITCH_USERNAME");
    const clientId = runtime.getSetting("TWITCH_CLIENT_ID");
    const accessToken = runtime.getSetting("TWITCH_ACCESS_TOKEN");
    const channel = runtime.getSetting("TWITCH_CHANNEL");

    logger.info("=".repeat(60));
    logger.info("Twitch Plugin Configuration");
    logger.info("=".repeat(60));
    logger.info(`  Username: ${username ? "✓ Set" : "✗ Missing (required)"}`);
    logger.info(`  Client ID: ${clientId ? "✓ Set" : "✗ Missing (required)"}`);
    logger.info(
      `  Access Token: ${accessToken ? "✓ Set" : "✗ Missing (required)"}`,
    );
    logger.info(
      `  Channel: ${channel ? `✓ ${channel}` : "✗ Missing (required)"}`,
    );
    logger.info("=".repeat(60));

    // Validate required settings
    const missing: string[] = [];
    if (!username) missing.push("TWITCH_USERNAME");
    if (!clientId) missing.push("TWITCH_CLIENT_ID");
    if (!accessToken) missing.push("TWITCH_ACCESS_TOKEN");
    if (!channel) missing.push("TWITCH_CHANNEL");

    if (missing.length > 0) {
      logger.warn(
        `Twitch plugin: Missing required configuration: ${missing.join(", ")}`,
      );
    }

    // Additional optional settings
    const clientSecret = runtime.getSetting("TWITCH_CLIENT_SECRET");
    const refreshToken = runtime.getSetting("TWITCH_REFRESH_TOKEN");
    const additionalChannels = runtime.getSetting("TWITCH_CHANNELS");
    const requireMention = runtime.getSetting("TWITCH_REQUIRE_MENTION");
    const allowedRoles = runtime.getSetting("TWITCH_ALLOWED_ROLES");

    if (clientSecret && refreshToken) {
      logger.info(
        "  Token Refresh: ✓ Enabled (client secret and refresh token set)",
      );
    } else if (clientSecret || refreshToken) {
      logger.warn(
        "  Token Refresh: ⚠ Partial (need both TWITCH_CLIENT_SECRET and TWITCH_REFRESH_TOKEN)",
      );
    }

    if (additionalChannels) {
      logger.info(`  Additional Channels: ${additionalChannels}`);
    }

    if (requireMention === "true") {
      logger.info(
        "  Require Mention: ✓ Enabled (will only respond to @mentions)",
      );
    }

    if (allowedRoles) {
      logger.info(`  Allowed Roles: ${allowedRoles}`);
    }
  },
};

export default twitchPlugin;
