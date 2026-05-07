import { logger } from "../../../logger.ts";
import type { Provider, ProviderResult } from "../../../types/components.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import type { PluginManagerService } from "../services/pluginManagerService.ts";
import { getAllPlugins } from "../services/pluginRegistryService.ts";
import {
	buildProviderKeywords,
	COMMON_CONNECTOR_KEYWORDS,
	isProviderRelevant,
	keywordsFromPluginNames,
	PLUGIN_MANAGER_BASE_KEYWORDS,
} from "./relevance.ts";

const MAX_REGISTRY_PROVIDER_ITEMS = 25;
const MAX_REGISTRY_TAGS = 6;

const REGISTRY_PROVIDER_KEYWORDS = buildProviderKeywords(
	PLUGIN_MANAGER_BASE_KEYWORDS,
	COMMON_CONNECTOR_KEYWORDS,
	[
		"plugin registry",
		"registry plugin",
		"registry plugins",
		"plugin catalog",
		"plugin marketplace",
		"discover plugins",
		"search plugins",
		"available plugins",
		"installed plugins",
		"plugin directory",
		"integration directory",
		"connector directory",
		"connect plugin",
		"install plugin",
	],
);

export const registryPluginsProvider: Provider & {
	relevanceKeywords: string[];
} = {
	name: "registryPlugins",
	description:
		"Provides available plugins from the ElizaOS registry (next branch), installed plugin status, and searchable plugin knowledge",

	dynamic: true,
	relevanceKeywords: REGISTRY_PROVIDER_KEYWORDS,
	contexts: ["connectors", "settings"],
	contextGate: { anyOf: ["connectors", "settings"] },
	cacheStable: true,
	cacheScope: "agent",
	roleGate: { minRole: "USER" },

	async get(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> {
		const pluginManagerService = runtime.getService(
			"plugin_manager",
		) as PluginManagerService;
		const dynamicPluginKeywords = pluginManagerService
			? keywordsFromPluginNames(
					pluginManagerService.getAllPlugins().map((plugin) => plugin.name),
				)
			: [];
		const relevanceKeywords = buildProviderKeywords(
			REGISTRY_PROVIDER_KEYWORDS,
			dynamicPluginKeywords,
		);

		if (!isProviderRelevant(message, state, relevanceKeywords)) {
			return { text: "" };
		}

		if (!pluginManagerService) {
			return {
				text: "Plugin manager service not available",
				data: { error: "Plugin manager service not available" },
			};
		}

		let registryPlugins: Awaited<ReturnType<typeof getAllPlugins>> = [];
		let registryError: string | undefined;

		try {
			registryPlugins = await getAllPlugins();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(
				`[registryPluginsProvider] Failed to fetch registry: ${message}`,
			);
			registryError = message;
		}

		const installedPlugins = await pluginManagerService.listInstalledPlugins();
		const visibleRegistryPlugins = registryPlugins.slice(
			0,
			MAX_REGISTRY_PROVIDER_ITEMS,
		);
		const visibleInstalledPlugins = installedPlugins.slice(
			0,
			MAX_REGISTRY_PROVIDER_ITEMS,
		);

		let text = "";

		if (registryError) {
			text += `**Registry unavailable:** ${registryError}\n`;
		} else if (registryPlugins.length === 0) {
			text += "No plugins available in registry.\n";
		} else {
			text += `**Available Plugins from Registry (${registryPlugins.length} total):**\n`;
			for (const plugin of visibleRegistryPlugins) {
				text += `- **${plugin.name}**: ${plugin.description || "No description"}\n`;
				if (plugin.tags && plugin.tags.length > 0) {
					text += `  Tags: ${plugin.tags.slice(0, MAX_REGISTRY_TAGS).join(", ")}\n`;
				}
			}
		}

		if (installedPlugins.length > 0) {
			text += "\n**Installed Registry Plugins:**\n";
			for (const plugin of visibleInstalledPlugins) {
				text += `- **${plugin.name}** v${plugin.version} (Path: ${plugin.path})\n`;
			}
		}

		return {
			text,
			data: {
				availablePlugins: visibleRegistryPlugins.map((p) => ({
					name: p.name,
					description: p.description,
					repository: p.repository,
					tags: (p.tags || []).slice(0, MAX_REGISTRY_TAGS),
					version: p.latestVersion,
				})),
				installedPlugins: visibleInstalledPlugins,
				registryError,
				truncated:
					registryPlugins.length > visibleRegistryPlugins.length ||
					installedPlugins.length > visibleInstalledPlugins.length,
			},
			values: {
				availableCount: registryPlugins.length,
				installedCount: installedPlugins.length,
				registryAvailable: !registryError,
			},
		};
	},
};
