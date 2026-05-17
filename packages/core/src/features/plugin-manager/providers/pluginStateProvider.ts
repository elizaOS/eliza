import type { Provider, ProviderResult } from "../../../types/components.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import type { PluginManagerService } from "../services/pluginManagerService.ts";
import { type PluginState, PluginStatus } from "../types.ts";
import {
	buildProviderKeywords,
	COMMON_CONNECTOR_KEYWORDS,
	isProviderRelevant,
	keywordsFromPluginNames,
	PLUGIN_MANAGER_BASE_KEYWORDS,
} from "./relevance.ts";

const MAX_PLUGIN_STATE_ITEMS = 20;
const MAX_EJECTED_PLUGIN_ITEMS = 10;

const PLUGIN_STATE_PROVIDER_KEYWORDS = buildProviderKeywords(
	PLUGIN_MANAGER_BASE_KEYWORDS,
	COMMON_CONNECTOR_KEYWORDS,
	[
		"plugin state",
		"plugin states",
		"loaded plugins",
		"unloaded plugins",
		"ready plugins",
		"plugin errors",
		"ejected plugins",
		"enabled plugins",
		"disabled plugins",
		"protected plugins",
		"original plugins",
		"startup plugins",
		"integration state",
		"connector state",
	],
);

export const pluginStateProvider: Provider & { relevanceKeywords: string[] } = {
	name: "pluginState",
	description:
		"Provides information about the current state of all plugins including loaded status, missing environment variables, and errors",

	dynamic: true,
	relevanceKeywords: PLUGIN_STATE_PROVIDER_KEYWORDS,
	contexts: ["connectors", "settings"],
	contextGate: { anyOf: ["connectors", "settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	async get(
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<ProviderResult> {
		try {
			const pluginManager = runtime.getService(
				"plugin_manager",
			) as PluginManagerService;
			const dynamicPluginKeywords = pluginManager
				? keywordsFromPluginNames(
						pluginManager.getAllPlugins().map((plugin) => plugin.name),
					)
				: [];
			const relevanceKeywords = buildProviderKeywords(
				PLUGIN_STATE_PROVIDER_KEYWORDS,
				dynamicPluginKeywords,
			);

			if (!isProviderRelevant(message, state, relevanceKeywords)) {
				return { text: "" };
			}

			if (!pluginManager) {
				return {
					text: "Plugin Manager service is not available",
					values: {},
					data: {
						error: "Plugin Manager service not found",
					},
				};
			}

			const plugins = pluginManager.getAllPlugins();
			const loadedPlugins = plugins.filter(
				(p) => p.status === PluginStatus.LOADED,
			);
			const errorPlugins = plugins.filter(
				(p) => p.status === PluginStatus.ERROR,
			);
			const readyPlugins = plugins.filter(
				(p) => p.status === PluginStatus.READY,
			);
			const unloadedPlugins = plugins.filter(
				(p) => p.status === PluginStatus.UNLOADED,
			);

			const formatPlugin = (plugin: PluginState) => {
				const parts: string[] = [`${plugin.name} (${plugin.status})`];

				if (plugin.error) {
					parts.push(`Error: ${plugin.error}`);
				}

				if (plugin.loadedAt) {
					parts.push(
						`Loaded at: ${new Date(plugin.loadedAt).toLocaleString()}`,
					);
				}

				return parts.join(" - ");
			};

			const sections: string[] = [];

			if (loadedPlugins.length > 0) {
				sections.push(
					`**Loaded Plugins:**\n${loadedPlugins
						.slice(0, MAX_PLUGIN_STATE_ITEMS)
						.map((p) => `- ${formatPlugin(p)}`)
						.join("\n")}`,
				);
			}

			if (errorPlugins.length > 0) {
				sections.push(
					`**Plugins with Errors:**\n${errorPlugins
						.slice(0, MAX_PLUGIN_STATE_ITEMS)
						.map((p) => `- ${formatPlugin(p)}`)
						.join("\n")}`,
				);
			}

			if (readyPlugins.length > 0) {
				sections.push(
					`**Ready to Load:**\n${readyPlugins
						.slice(0, MAX_PLUGIN_STATE_ITEMS)
						.map((p) => `- ${formatPlugin(p)}`)
						.join("\n")}`,
				);
			}

			if (unloadedPlugins.length > 0) {
				sections.push(
					`**Unloaded:**\n${unloadedPlugins
						.slice(0, MAX_PLUGIN_STATE_ITEMS)
						.map((p) => `- ${formatPlugin(p)}`)
						.join("\n")}`,
				);
			}

			const protectedPlugins = pluginManager.getProtectedPlugins();
			const originalPlugins = pluginManager.getOriginalPlugins();
			const ejectedPlugins = await pluginManager.listEjectedPlugins();
			const visibleEjectedPlugins = ejectedPlugins.slice(
				0,
				MAX_EJECTED_PLUGIN_ITEMS,
			);

			if (ejectedPlugins.length > 0) {
				sections.push(
					`**Ejected Plugins:**\n${visibleEjectedPlugins.map((p) => `- ${p.name} (v${p.version}) at ${p.path}`).join("\n")}`,
				);
			}

			if (protectedPlugins.length > 0 || originalPlugins.length > 0) {
				sections.push(
					"**System Plugins:**\n" +
						`- Protected: ${protectedPlugins.join(", ")}\n` +
						`- Original (loaded at startup): ${originalPlugins.join(", ")}`,
				);
			}

			const text =
				sections.length > 0
					? sections.join("\n\n")
					: "No plugins registered in the Plugin Manager.";

			return {
				text,
				values: {
					totalPlugins: plugins.length,
					loadedCount: loadedPlugins.length,
					errorCount: errorPlugins.length,
					readyCount: readyPlugins.length,
					unloadedCount: unloadedPlugins.length,
					ejectedCount: ejectedPlugins.length,
					protectedPlugins,
					originalPlugins,
				},
				data: {
					plugins: plugins.slice(0, MAX_PLUGIN_STATE_ITEMS).map((p) => ({
						id: p.id,
						name: p.name,
						status: p.status,
						error: p.error,
						createdAt: p.createdAt,
						loadedAt: p.loadedAt,
						unloadedAt: p.unloadedAt,
						isProtected: protectedPlugins.includes(p.name),
						isOriginal: originalPlugins.includes(p.name),
					})),
					ejectedPlugins: visibleEjectedPlugins,
					truncated: plugins.length > MAX_PLUGIN_STATE_ITEMS,
				},
			};
		} catch (error) {
			return {
				text: "Plugin state unavailable",
				values: {},
				data: {
					error: error instanceof Error ? error.message : String(error),
				},
			};
		}
	},
};
