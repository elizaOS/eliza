/**
 * BlueBubbles Plugin for ElizaOS
 *
 * Provides iMessage integration via the BlueBubbles macOS app and REST API,
 * supporting text messages, reactions, effects, and more.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { BlueBubblesService } from "./service.js";
import {
	blueBubblesSetupRoutes,
	resolveBlueBubblesWebhookPath,
} from "./setup-routes.js";

export * from "./constants.js";
// Re-export types and service
export * from "./types.js";
export {
	BlueBubblesService,
	blueBubblesSetupRoutes,
	resolveBlueBubblesWebhookPath,
};

/**
 * BlueBubbles plugin for ElizaOS agents.
 */
const blueBubblesPlugin: Plugin = {
	name: "bluebubbles",
	description: "BlueBubbles iMessage bridge plugin for ElizaOS agents",

	services: [BlueBubblesService],
	actions: [],
	providers: [],
	routes: blueBubblesSetupRoutes,
	tests: [],

	init: async (
		config: Record<string, string>,
		_runtime: IAgentRuntime,
	): Promise<void> => {
		logger.info("Initializing BlueBubbles plugin...");

		const hasServerUrl = Boolean(
			config.BLUEBUBBLES_SERVER_URL || process.env.BLUEBUBBLES_SERVER_URL,
		);
		const hasPassword = Boolean(
			config.BLUEBUBBLES_PASSWORD || process.env.BLUEBUBBLES_PASSWORD,
		);

		logger.info("BlueBubbles plugin configuration:");
		logger.info(`  - Server URL configured: ${hasServerUrl ? "Yes" : "No"}`);
		logger.info(`  - Password configured: ${hasPassword ? "Yes" : "No"}`);
		logger.info(
			`  - DM policy: ${config.BLUEBUBBLES_DM_POLICY || process.env.BLUEBUBBLES_DM_POLICY || "pairing"}`,
		);
		logger.info(
			`  - Group policy: ${config.BLUEBUBBLES_GROUP_POLICY || process.env.BLUEBUBBLES_GROUP_POLICY || "allowlist"}`,
		);

		if (!hasServerUrl) {
			logger.warn(
				"BlueBubbles server URL not configured. Set BLUEBUBBLES_SERVER_URL.",
			);
		}

		if (!hasPassword) {
			logger.warn(
				"BlueBubbles password not configured. Set BLUEBUBBLES_PASSWORD.",
			);
		}

		logger.info("BlueBubbles plugin initialized");
	},
};

export default blueBubblesPlugin;
