/**
 * Browser build entry for the Linear plugin: a stub that warns the plugin is
 * unsupported in-browser and does nothing else. The Linear SDK requires a Node
 * runtime, so browser bundles must reach Linear through a server proxy.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";

const pluginName = "@elizaos/plugin-linear-ts";

export const linearPlugin: Plugin = {
	name: pluginName,
	description: "Linear plugin (unsupported browser export; use a server proxy)",
	async init(
		_config: Record<string, string>,
		_runtime: IAgentRuntime,
	): Promise<void> {
		logger.warn(
			`[plugin-${pluginName}] This plugin is not supported directly in browsers. Use a server proxy.`,
		);
	},
};

export default linearPlugin;
