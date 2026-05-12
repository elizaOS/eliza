import { logger } from "../../../logger.ts";
import type { Plugin as ElizaPlugin } from "../../../types/plugin.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import { Service } from "../../../types/service.ts";
import { PluginManagerServiceType } from "../types.ts";

/**
 * Plugin configuration service that checks actual plugin config schemas
 * against the runtime's environment/settings.
 *
 * This service works with real data from registered plugins, NOT by
 * guessing paths or scanning source files on disk.
 */
export class PluginConfigurationService extends Service {
	static override serviceType = PluginManagerServiceType.PLUGIN_CONFIGURATION;
	override capabilityDescription =
		"Checks plugin configuration status against runtime settings";

	static async start(
		runtime: IAgentRuntime,
	): Promise<PluginConfigurationService> {
		const service = new PluginConfigurationService(runtime);
		logger.info("[PluginConfigurationService] Started");
		return service;
	}

	/**
	 * Check which env vars from a plugin's config schema are missing.
	 * Uses the plugin's actual `config` field (if defined) to determine requirements.
	 */
	getMissingConfigKeys(plugin: ElizaPlugin): string[] {
		if (!plugin.config) {
			return [];
		}

		const missing: string[] = [];
		for (const [key, defaultValue] of Object.entries(plugin.config)) {
			// A config key is "missing" if it has no default and no env var set
			if (defaultValue === null || defaultValue === "") {
				// Check if there's an environment variable set for it
				if (!process.env[key]) {
					missing.push(key);
				}
			}
		}
		return missing;
	}

	/**
	 * Get configuration status for a specific plugin.
	 * Returns actual missing keys based on the plugin's config schema.
	 */
	getPluginConfigStatus(plugin: ElizaPlugin): {
		configured: boolean;
		missingKeys: string[];
		totalKeys: number;
	} {
		if (!plugin.config) {
			return { configured: true, missingKeys: [], totalKeys: 0 };
		}

		const missingKeys = this.getMissingConfigKeys(plugin);
		return {
			configured: missingKeys.length === 0,
			missingKeys,
			totalKeys: Object.keys(plugin.config).length,
		};
	}

	async stop(): Promise<void> {
		logger.info("[PluginConfigurationService] Stopped");
	}
}
