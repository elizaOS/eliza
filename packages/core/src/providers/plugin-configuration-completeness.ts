/**
 * Plugin Configuration Completeness Provider
 *
 * For every registered plugin, reports `{ name, ready, missing[] }` by
 * polling the runtime-injected `PluginConfigClient`. Plugins without a
 * manifest are skipped silently. Returns `{ plugins: [] }` when the client
 * is absent — never throws.
 *
 * Position: -10.
 */

import {
	PLUGIN_CONFIG_CLIENT_SERVICE,
	type PluginConfigClient,
} from "../features/plugin-config/types.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../types/index.ts";

interface PluginCompletenessEntry {
	name: string;
	ready: boolean;
	missing: string[];
}

export const pluginConfigurationCompletenessProvider: Provider = {
	name: "PLUGIN_CONFIGURATION_COMPLETENESS",
	description:
		"Per-plugin readiness and missing-config-key snapshot for the active plugin set.",
	position: -10,
	dynamic: true,
	contexts: ["settings", "agent_internal"],
	contextGate: { anyOf: ["settings", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "OWNER" },

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		const client = runtime.getService(
			PLUGIN_CONFIG_CLIENT_SERVICE,
		) as unknown as PluginConfigClient | null;
		if (!client) {
			return {
				text: "",
				data: { plugins: [] as PluginCompletenessEntry[] },
				values: { pluginsTotal: 0, pluginsReady: 0, pluginsMissing: 0 },
			};
		}

		const plugins: PluginCompletenessEntry[] = [];
		for (const plugin of runtime.plugins ?? []) {
			const status = await client.getStatus(plugin.name);
			if (!status) continue;
			plugins.push({
				name: plugin.name,
				ready: status.ready,
				missing: status.missing,
			});
		}

		const readyCount = plugins.filter((p) => p.ready).length;
		const missingCount = plugins.length - readyCount;
		const text =
			plugins.length === 0
				? ""
				: `[Plugin Config] ${readyCount}/${plugins.length} ready${
						missingCount > 0
							? `; missing keys for: ${plugins
									.filter((p) => !p.ready)
									.map((p) => `${p.name}(${p.missing.join(",")})`)
									.join("; ")}`
							: ""
					}`;

		return {
			text,
			data: { plugins },
			values: {
				pluginsTotal: plugins.length,
				pluginsReady: readyCount,
				pluginsMissing: missingCount,
			},
		};
	},
};

export default pluginConfigurationCompletenessProvider;
