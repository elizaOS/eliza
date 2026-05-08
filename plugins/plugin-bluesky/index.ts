import {
	getConnectorAccountManager,
	type IAgentRuntime,
	logger,
	type Plugin,
	type TestCase,
	type TestSuite,
} from "@elizaos/core";
import { createBlueSkyConnectorAccountProvider } from "./connector-account-provider";
import { BlueSkyService } from "./services/bluesky";
import { getApiKeyOptional } from "./utils/config";

export {
	DEFAULT_BLUESKY_ACCOUNT_ID,
	listBlueSkyAccountIds,
	normalizeBlueSkyAccountId,
	readBlueSkyAccountId,
	resolveDefaultBlueSkyAccountId,
} from "./utils/config";
export { BlueSkyClient } from "./client";
export {
	BLUESKY_PROVIDER_ID,
	createBlueSkyConnectorAccountProvider,
} from "./connector-account-provider";
export { BlueSkyService } from "./services/bluesky";

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
	readonly BLUESKY_ACCOUNTS?: string;
	readonly BLUESKY_DEFAULT_ACCOUNT_ID?: string;
}

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
						throw new Error(
							"BLUESKY_HANDLE and BLUESKY_PASSWORD are not configured",
						);
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
						logger.log(
							"Skipping service initialization test - credentials not configured",
						);
						return;
					}

					const service = await BlueSkyService.start(runtime);
					if (!service) {
						throw new Error("Failed to initialize BlueSky service");
					}
					logger.log("BlueSky service initialized successfully");
				},
			},
		] as TestCase[],
	},
] as TestSuite[];

export const blueSkyPlugin: Plugin = {
	name: "bluesky",
	description:
		"BlueSky client plugin using AT Protocol for social interactions",

	config: {
		BLUESKY_HANDLE: process.env.BLUESKY_HANDLE ?? null,
		BLUESKY_PASSWORD: process.env.BLUESKY_PASSWORD ?? null,
		BLUESKY_SERVICE: process.env.BLUESKY_SERVICE ?? null,
		BLUESKY_DRY_RUN: process.env.BLUESKY_DRY_RUN ?? null,
		BLUESKY_POLL_INTERVAL: process.env.BLUESKY_POLL_INTERVAL ?? null,
		BLUESKY_ENABLE_POSTING: process.env.BLUESKY_ENABLE_POSTING ?? null,
		BLUESKY_ENABLE_DMS: process.env.BLUESKY_ENABLE_DMS ?? null,
		BLUESKY_POST_INTERVAL_MIN: process.env.BLUESKY_POST_INTERVAL_MIN ?? null,
		BLUESKY_POST_INTERVAL_MAX: process.env.BLUESKY_POST_INTERVAL_MAX ?? null,
		BLUESKY_ENABLE_ACTION_PROCESSING:
			process.env.BLUESKY_ENABLE_ACTION_PROCESSING ?? null,
		BLUESKY_ACTION_INTERVAL: process.env.BLUESKY_ACTION_INTERVAL ?? null,
		BLUESKY_POST_IMMEDIATELY: process.env.BLUESKY_POST_IMMEDIATELY ?? null,
		BLUESKY_MAX_ACTIONS_PROCESSING:
			process.env.BLUESKY_MAX_ACTIONS_PROCESSING ?? null,
		BLUESKY_MAX_POST_LENGTH: process.env.BLUESKY_MAX_POST_LENGTH ?? null,
		BLUESKY_ACCOUNTS: process.env.BLUESKY_ACCOUNTS ?? null,
		BLUESKY_DEFAULT_ACCOUNT_ID: process.env.BLUESKY_DEFAULT_ACCOUNT_ID ?? null,
	},

	async init(_config, runtime) {
		try {
			const manager = getConnectorAccountManager(runtime);
			manager.registerProvider(createBlueSkyConnectorAccountProvider(runtime));
		} catch (err) {
			logger.warn(
				{
					src: "plugin:bluesky",
					err: err instanceof Error ? err.message : String(err),
				},
				"Failed to register BlueSky provider with ConnectorAccountManager",
			);
		}
		logger.log("BlueSky plugin initialized");
	},

	actions: [],

	services: [BlueSkyService],

	tests: pluginTests,
};

export default blueSkyPlugin;
