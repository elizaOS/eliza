import type { Action, HandlerOptions } from "../../../types/components.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import type { State } from "../../../types/state.ts";
import type { PluginManagerService } from "../services/pluginManagerService.ts";
import type { EjectedPluginInfo } from "../types.ts";

export const listEjectedPluginsAction: Action = {
	name: "LIST_EJECTED_PLUGINS",
	description: "List all ejected plugins currently being managed locally",
	suppressPostActionContinuation: true,
	similes: [
		"list ejected",
		"show ejected plugins",
		"which plugins are ejected",
		"list local plugins",
	],

	examples: [
		[
			{
				name: "{{user1}}",
				content: {
					text: "list ejected plugins",
					action: "LIST_EJECTED_PLUGINS",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Here are the ejected plugins: ...",
					action: "LIST_EJECTED_PLUGINS",
				},
			},
		],
	],

	async handler(runtime, _message, _state, _options, callback) {
		const pluginManagerService = runtime.getService(
			"plugin_manager",
		) as PluginManagerService;

		if (!pluginManagerService) {
			const text = "Plugin manager service not available";
			if (callback)
				await callback({ text, actions: ["LIST_EJECTED_PLUGINS"] });
			return {
				success: false,
				text,
				data: { actionName: "LIST_EJECTED_PLUGINS" },
			};
		}

		try {
			const plugins: EjectedPluginInfo[] =
				await pluginManagerService.listEjectedPlugins();

			if (plugins.length === 0) {
				const text = "No ejected plugins found.";
				if (callback)
					await callback({ text, actions: ["LIST_EJECTED_PLUGINS"] });
				return {
					success: true,
					text,
					data: { actionName: "LIST_EJECTED_PLUGINS", plugins },
				};
			} else {
				const list = plugins
					.map((p) => `- ${p.name} (v${p.version}) at ${p.path}`)
					.join("\n");
				const text = `Ejected Plugins:\n${list}`;
				if (callback)
					await callback({ text, actions: ["LIST_EJECTED_PLUGINS"] });
				return {
					success: true,
					text,
					data: { actionName: "LIST_EJECTED_PLUGINS", plugins },
				};
			}
		} catch (error) {
			const text = `Error listing ejected plugins: ${error instanceof Error ? error.message : String(error)}`;
			if (callback)
				await callback({
					text,
					actions: ["LIST_EJECTED_PLUGINS"],
				});
			return {
				success: false,
				text,
				error: error instanceof Error ? error.message : String(error),
				data: { actionName: "LIST_EJECTED_PLUGINS" },
			};
		}
	},

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		const text = message.content?.text?.toLowerCase() ?? "";
		return (
			text.includes("ejected") &&
			text.includes("plugin") &&
			Boolean(runtime.getService("plugin_manager"))
		);
	},
};
