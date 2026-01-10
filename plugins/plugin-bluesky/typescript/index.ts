/**
 * BlueSky Plugin for elizaOS
 *
 * Provides BlueSky (AT Protocol) integration for posting, messaging, and notifications.
 *
 * ## Features
 *
 * - Post creation and management
 * - Direct messaging
 * - Notification polling and processing
 * - Profile management
 * - Timeline access
 *
 * ## Configuration
 *
 * Required:
 * - BLUESKY_HANDLE: Your BlueSky handle (e.g., user.bsky.social)
 * - BLUESKY_PASSWORD: Your app password
 *
 * Optional:
 * - BLUESKY_SERVICE: BlueSky service URL (default: https://bsky.social)
 * - BLUESKY_DRY_RUN: Simulate operations without executing (default: false)
 * - BLUESKY_POLL_INTERVAL: Notification polling interval in seconds (default: 60)
 * - BLUESKY_ENABLE_POSTING: Enable automated posting (default: true)
 * - BLUESKY_ENABLE_DMS: Enable direct messaging (default: true)
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { BlueSkyService } from "./services/bluesky";
import { getApiKeyOptional } from "./utils/config";

// Re-export types for consumers
export * from "./types";
export { BlueSkyClient } from "./client";
export { BlueSkyService } from "./services/bluesky";
export { BlueSkyConfig, validateBlueSkyConfig, hasBlueSkyEnabled } from "./utils/config";

/**
 * Plugin configuration object structure
 */
export interface PluginConfig {
  readonly BLUESKY_HANDLE?: string;
  readonly BLUESKY_PASSWORD?: string;
  readonly BLUESKY_SERVICE?: string;
  readonly BLUESKY_DRY_RUN?: string;
  readonly BLUESKY_POLL_INTERVAL?: string;
  readonly BLUESKY_ENABLE_POSTING?: string;
  readonly BLUESKY_ENABLE_DMS?: string;
  readonly BLUESKY_POST_INTERVAL_MIN?: string;
  readonly BLUESKY_POST_INTERVAL_MAX?: string;
  readonly BLUESKY_ENABLE_ACTION_PROCESSING?: string;
  readonly BLUESKY_ACTION_INTERVAL?: string;
  readonly BLUESKY_POST_IMMEDIATELY?: string;
  readonly BLUESKY_MAX_ACTIONS_PROCESSING?: string;
  readonly BLUESKY_MAX_POST_LENGTH?: string;
}

/**
 * Test suite for the BlueSky plugin.
 */
const pluginTests = [
  {
    name: "bluesky_plugin_tests",
    tests: [
      {
        name: "bluesky_test_credentials_validation",
        fn: async (runtime: IAgentRuntime) => {
          const handle = getApiKeyOptional(runtime, "BLUESKY_HANDLE");
          const password = getApiKeyOptional(runtime, "BLUESKY_PASSWORD");
          if (!handle || !password) {
            throw new Error("BLUESKY_HANDLE and BLUESKY_PASSWORD are not configured");
          }
          logger.log("BlueSky credentials are configured");
        },
      },
      {
        name: "bluesky_test_service_initialization",
        fn: async (runtime: IAgentRuntime) => {
          const handle = getApiKeyOptional(runtime, "BLUESKY_HANDLE");
          const password = getApiKeyOptional(runtime, "BLUESKY_PASSWORD");
          if (!handle || !password) {
            logger.log("Skipping service initialization test - credentials not configured");
            return;
          }

          const service = await BlueSkyService.start(runtime);
          if (!service) {
            throw new Error("Failed to initialize BlueSky service");
          }
          logger.log("BlueSky service initialized successfully");
        },
      },
    ],
  },
];

/**
 * BlueSky plugin for elizaOS.
 *
 * Provides BlueSky integration using the AT Protocol for posting,
 * messaging, notifications, and profile management.
 */
export const blueSkyPlugin: Plugin = {
  name: "bluesky",
  description: "BlueSky client plugin using AT Protocol for social interactions",

  config: {
    BLUESKY_HANDLE: process.env["BLUESKY_HANDLE"],
    BLUESKY_PASSWORD: process.env["BLUESKY_PASSWORD"],
    BLUESKY_SERVICE: process.env["BLUESKY_SERVICE"],
    BLUESKY_DRY_RUN: process.env["BLUESKY_DRY_RUN"],
    BLUESKY_POLL_INTERVAL: process.env["BLUESKY_POLL_INTERVAL"],
    BLUESKY_ENABLE_POSTING: process.env["BLUESKY_ENABLE_POSTING"],
    BLUESKY_ENABLE_DMS: process.env["BLUESKY_ENABLE_DMS"],
    BLUESKY_POST_INTERVAL_MIN: process.env["BLUESKY_POST_INTERVAL_MIN"],
    BLUESKY_POST_INTERVAL_MAX: process.env["BLUESKY_POST_INTERVAL_MAX"],
    BLUESKY_ENABLE_ACTION_PROCESSING: process.env["BLUESKY_ENABLE_ACTION_PROCESSING"],
    BLUESKY_ACTION_INTERVAL: process.env["BLUESKY_ACTION_INTERVAL"],
    BLUESKY_POST_IMMEDIATELY: process.env["BLUESKY_POST_IMMEDIATELY"],
    BLUESKY_MAX_ACTIONS_PROCESSING: process.env["BLUESKY_MAX_ACTIONS_PROCESSING"],
    BLUESKY_MAX_POST_LENGTH: process.env["BLUESKY_MAX_POST_LENGTH"],
  },

  async init(_config, _runtime) {
    logger.log("BlueSky plugin initialized");
  },

  services: [BlueSkyService],

  tests: pluginTests,
};

export default blueSkyPlugin;

