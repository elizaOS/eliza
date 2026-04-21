import type { Provider, ProviderResult } from "../../../types/components.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import type { PluginConfigurationService } from "../services/pluginConfigurationService.ts";
import type { PluginManagerService } from "../services/pluginManagerService.ts";
import { PluginManagerServiceType } from "../types.ts";
import {
	buildProviderKeywords,
	COMMON_CONNECTOR_KEYWORDS,
	isProviderRelevant,
	keywordsFromPluginNames,
	PLUGIN_MANAGER_BASE_KEYWORDS,
} from "./relevance.ts";

const PLUGIN_CONFIGURATION_STATUS_KEYWORDS = buildProviderKeywords(
	PLUGIN_MANAGER_BASE_KEYWORDS,
	COMMON_CONNECTOR_KEYWORDS,
	[
		"plugin configuration",
		"configuration status",
		"config status",
		"schema",
		"config schema",
		"missing keys",
		"missing env",
		"environment variable",
		"environment variables",
		"env var",
		"env vars",
		"setup",
		"configure plugin",
		"plugin settings",
		"integration config",
		"connector config",
		"credential",
		"credentials",
		"secret",
		"secrets",
	],
);

export const pluginConfigurationStatusProvider: Provider & {
	relevanceKeywords: string[];
} = {
	name: "pluginConfigurationStatus",
	description:
		"Provides plugin configuration status based on actual plugin config schemas",

	dynamic: true,
	relevanceKeywords: PLUGIN_CONFIGURATION_STATUS_KEYWORDS,
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> => {
		const pluginManagerService = runtime.getService(
			PluginManagerServiceType.PLUGIN_MANAGER,
		) as PluginManagerService | null;
		const dynamicPluginKeywords = pluginManagerService
			? keywordsFromPluginNames(
					pluginManagerService.getAllPlugins().map((plugin) => plugin.name),
				)
			: [];
		const relevanceKeywords = buildProviderKeywords(
			PLUGIN_CONFIGURATION_STATUS_KEYWORDS,
			dynamicPluginKeywords,
		);

		if (!isProviderRelevant(message, state, relevanceKeywords)) {
			return { text: "" };
		}

		const configService = runtime.getService(
			PluginManagerServiceType.PLUGIN_CONFIGURATION,
		) as PluginConfigurationService | null;

		if (!configService || !pluginManagerService) {
			return {
				text: "Configuration or plugin manager service not available",
				data: { available: false },
				values: { configurationServicesAvailable: false },
			};
		}

		const allPlugins = pluginManagerService.getAllPlugins();

		let configuredCount = 0;
		let needsConfigCount = 0;
		const pluginStatuses: Array<{
			name: string;
			status: string;
			configured: boolean;
			missingKeys: string[];
			totalKeys: number;
		}> = [];

		for (const pluginState of allPlugins) {
			if (!pluginState.plugin) {
				pluginStatuses.push({
					name: pluginState.name,
					status: pluginState.status,
					configured: true,
					missingKeys: [],
					totalKeys: 0,
				});
				configuredCount++;
				continue;
			}

			const configStatus = configService.getPluginConfigStatus(
				pluginState.plugin,
			);
			pluginStatuses.push({
				name: pluginState.name,
				status: pluginState.status,
				configured: configStatus.configured,
				missingKeys: configStatus.missingKeys,
				totalKeys: configStatus.totalKeys,
			});

			if (configStatus.configured) {
				configuredCount++;
			} else {
				needsConfigCount++;
			}
		}

		let statusText = "";
		if (allPlugins.length === 0) {
			statusText = "No plugins registered.";
		} else {
			statusText += `Plugin Configuration Status:\n`;
			statusText += `Total: ${allPlugins.length}, Configured: ${configuredCount}, Needs config: ${needsConfigCount}\n`;

			if (needsConfigCount > 0) {
				statusText += `\nPlugins needing configuration:\n`;
				for (const ps of pluginStatuses.filter((p) => !p.configured)) {
					statusText += `- ${ps.name}: missing ${ps.missingKeys.join(", ")}\n`;
				}
			}
		}

		return {
			text: statusText,
			data: { plugins: pluginStatuses },
			values: {
				configurationServicesAvailable: true,
				totalPlugins: allPlugins.length,
				configuredPlugins: configuredCount,
				needsConfiguration: needsConfigCount,
				hasUnconfiguredPlugins: needsConfigCount > 0,
			},
		};
	},
};
