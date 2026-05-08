/**
 * BlueBubbles Plugin for ElizaOS
 *
 * Provides iMessage integration via the BlueBubbles macOS app and REST API,
 * supporting text messages, reactions, effects, and more.
 */

import {
	getConnectorAccountManager,
	type IAgentRuntime,
	logger,
	type Plugin,
} from "@elizaos/core";
import { createBlueBubblesConnectorAccountProvider } from "./connector-account-provider.js";
import { BlueBubblesService } from "./service.js";
import {
	blueBubblesSetupRoutes,
	resolveBlueBubblesWebhookPath,
} from "./setup-routes.js";

// Account management exports
export {
	type BlueBubblesAccountConfig,
	type BlueBubblesMultiAccountConfig,
	DEFAULT_ACCOUNT_ID,
	isMultiAccountEnabled,
	listBlueBubblesAccountIds,
	listEnabledBlueBubblesAccounts,
	normalizeAccountId,
	type ResolvedBlueBubblesAccount,
	resolveBlueBubblesAccount,
	resolveDefaultBlueBubblesAccountId,
} from "./accounts.js";
// ConnectorAccountManager provider exports
export {
	BLUEBUBBLES_PROVIDER_ID,
	createBlueBubblesConnectorAccountProvider,
} from "./connector-account-provider.js";
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
		runtime: IAgentRuntime,
	): Promise<void> => {
		logger.info("Initializing BlueBubbles plugin...");

		// Register the BlueBubbles provider with the ConnectorAccountManager so
		// the HTTP CRUD surface (packages/agent/src/api/connector-account-routes.ts)
		// can list, create, patch, and delete BlueBubbles accounts.
		try {
			const manager = getConnectorAccountManager(runtime);
			manager.registerProvider(
				createBlueBubblesConnectorAccountProvider(runtime),
			);
		} catch (err) {
			logger.warn(
				{
					src: "plugin:bluebubbles",
					err: err instanceof Error ? err.message : String(err),
				},
				"Failed to register BlueBubbles provider with ConnectorAccountManager",
			);
		}

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
