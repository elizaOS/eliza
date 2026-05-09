/**
 * Matrix messaging integration plugin for ElizaOS.
 *
 * This plugin provides Matrix protocol integration using matrix-js-sdk.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";

export * from "./accounts.js";
// Service
export { MatrixService } from "./service.js";
// Types
export * from "./types.js";

// Import service for plugin
import { createMatrixConnectorAccountProvider } from "./connector-account-provider.js";
import { MatrixService } from "./service.js";

/**
 * Matrix plugin definition.
 */
const matrixPlugin: Plugin = {
  name: "matrix",
  description: "Matrix messaging integration plugin for ElizaOS with E2EE support",

  services: [MatrixService],

  actions: [],

  providers: [],

  tests: [],

  // Self-declared auto-enable: activate when the "matrix" connector is
  // configured under config.connectors. The hardcoded CONNECTOR_PLUGINS map
  // in plugin-auto-enable-engine.ts still serves as a fallback.
  autoEnable: {
    connectorKeys: ["matrix"],
  },

  init: async (_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    // Register the Matrix provider with the ConnectorAccountManager.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createMatrixConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:matrix",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Matrix provider with ConnectorAccountManager"
      );
    }

    const homeserver = runtime.getSetting("MATRIX_HOMESERVER");
    const userId = runtime.getSetting("MATRIX_USER_ID");
    const accessToken = runtime.getSetting("MATRIX_ACCESS_TOKEN");

    logger.info("=".repeat(60));
    logger.info("Matrix Plugin Configuration");
    logger.info("=".repeat(60));
    logger.info(`  Homeserver: ${homeserver ? `✓ ${homeserver}` : "✗ Missing (required)"}`);
    logger.info(`  User ID: ${userId ? `✓ ${userId}` : "✗ Missing (required)"}`);
    logger.info(`  Access Token: ${accessToken ? "✓ Set" : "✗ Missing (required)"}`);
    logger.info("=".repeat(60));

    // Validate required settings
    const missing: string[] = [];
    if (!homeserver) missing.push("MATRIX_HOMESERVER");
    if (!userId) missing.push("MATRIX_USER_ID");
    if (!accessToken) missing.push("MATRIX_ACCESS_TOKEN");

    if (missing.length > 0) {
      logger.warn(`Matrix plugin: Missing required configuration: ${missing.join(", ")}`);
    }

    // Additional optional settings
    const deviceId = runtime.getSetting("MATRIX_DEVICE_ID");
    const rooms = runtime.getSetting("MATRIX_ROOMS");
    const autoJoin = runtime.getSetting("MATRIX_AUTO_JOIN");
    const encryption = runtime.getSetting("MATRIX_ENCRYPTION");
    const requireMention = runtime.getSetting("MATRIX_REQUIRE_MENTION");

    if (deviceId) {
      logger.info(`  Device ID: ${deviceId}`);
    }

    if (rooms) {
      logger.info(`  Auto-join Rooms: ${rooms}`);
    }

    if (autoJoin === "true") {
      logger.info("  Auto-join Invites: ✓ Enabled");
    }

    if (encryption === "true") {
      logger.info("  End-to-End Encryption: ✓ Enabled");
    }

    if (requireMention === "true") {
      logger.info("  Require Mention: ✓ Enabled (will only respond to mentions in rooms)");
    }
  },
};

export default matrixPlugin;
