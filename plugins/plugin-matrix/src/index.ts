/**
 * Matrix messaging integration plugin for ElizaOS.
 *
 * This plugin provides Matrix protocol integration using matrix-js-sdk.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

// Service
export { MatrixService } from "./service.js";

// Types
export * from "./types.js";

import { joinRoom } from "./actions/joinRoom.js";
// Actions
import { MATRIX_MESSAGE_OP_ACTION, messageOp } from "./actions/messageOp.js";
import { matrixRoomsProvider } from "./providers/index.js";

export { joinRoom, MATRIX_MESSAGE_OP_ACTION, matrixRoomsProvider, messageOp };

// Import service for plugin
import { MatrixService } from "./service.js";
import { MatrixN8nCredentialProvider } from "./n8n-credential-provider.js";

/**
 * Matrix plugin definition.
 */
const matrixPlugin: Plugin = {
  name: "matrix",
  description: "Matrix messaging integration plugin for ElizaOS with E2EE support",

  services: [MatrixService, MatrixN8nCredentialProvider],

  actions: [messageOp, joinRoom],

  providers: [matrixRoomsProvider],

  tests: [],

  init: async (_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
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
