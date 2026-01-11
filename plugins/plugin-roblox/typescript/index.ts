/**
 * Roblox Plugin for elizaOS
 *
 * Provides full Roblox integration for sending and receiving messages
 * in Roblox games via the Open Cloud API.
 *
 * ## Features
 *
 * - Send messages to players in-game
 * - Execute custom game actions
 * - Look up player information
 * - DataStore operations for persistent storage
 * - Messaging Service for cross-server communication
 *
 * ## Configuration
 *
 * Required:
 * - ROBLOX_API_KEY: Roblox Open Cloud API key
 * - ROBLOX_UNIVERSE_ID: Universe ID of the experience
 *
 * Optional:
 * - ROBLOX_PLACE_ID: Specific place ID
 * - ROBLOX_WEBHOOK_SECRET: Secret for webhook validation
 * - ROBLOX_MESSAGING_TOPIC: Messaging topic (default: "eliza-agent")
 * - ROBLOX_POLL_INTERVAL: Poll interval in seconds (default: 30)
 * - ROBLOX_DRY_RUN: Enable dry run mode (default: false)
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { RobloxService } from "./services/RobloxService";
import { robloxActions } from "./actions";
import { robloxProviders } from "./providers";
import { RobloxTestSuite } from "./__tests__/suite";

// Re-export types and utilities for external use
export * from "./types";
export { RobloxClient, RobloxApiError } from "./client/RobloxClient";
export { RobloxService } from "./services/RobloxService";
export { validateRobloxConfig, hasRobloxEnabled } from "./utils/config";

/**
 * Roblox plugin for elizaOS.
 *
 * Provides full Roblox game integration including messaging,
 * actions, and player management.
 */
export const robloxPlugin: Plugin = {
  name: "roblox",
  description: "Roblox game integration plugin for sending and receiving messages",
  services: [RobloxService],
  actions: robloxActions,
  providers: robloxProviders,
  tests: [new RobloxTestSuite()],

  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    const apiKey = runtime.getSetting("ROBLOX_API_KEY") as string;
    const universeId = runtime.getSetting("ROBLOX_UNIVERSE_ID") as string;

    // Log configuration status
    if (!apiKey || apiKey.trim() === "") {
      runtime.logger.warn(
        "ROBLOX_API_KEY not provided - Roblox plugin is loaded but will not be functional"
      );
      runtime.logger.warn(
        "To enable Roblox functionality, please provide ROBLOX_API_KEY in your .env file"
      );
      return;
    }

    if (!universeId || universeId.trim() === "") {
      runtime.logger.warn(
        "ROBLOX_UNIVERSE_ID not provided - Roblox plugin is loaded but will not be functional"
      );
      runtime.logger.warn(
        "To enable Roblox functionality, please provide ROBLOX_UNIVERSE_ID in your .env file"
      );
      return;
    }

    runtime.logger.info(
      { universeId },
      "Roblox plugin initialized"
    );
  },
};

export default robloxPlugin;


