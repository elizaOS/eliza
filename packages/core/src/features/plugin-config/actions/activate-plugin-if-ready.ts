/**
 * ACTIVATE_PLUGIN_IF_READY — atomic action.
 *
 * If the plugin's config is satisfied, asks the `PluginConfigClient` to
 * register it with the runtime and emits a `PluginActivated` event. If not
 * ready, returns the still-missing keys and does nothing else.
 */

import { logger } from "../../../logger.ts";
import type {
	Action,
	EventPayload,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	PLUGIN_ACTIVATED_EVENT,
	type PluginActivatedEventPayload,
	PLUGIN_CONFIG_CLIENT_SERVICE,
	type PluginConfigClient,
} from "../types.ts";

interface ActivateParams {
	pluginName?: unknown;
}

function readParams(options: HandlerOptions | undefined): ActivateParams {
	if (!options?.parameters || typeof options.parameters !== "object") {
		return {};
	}
	return options.parameters as ActivateParams;
}

function dataFor(extra: Record<string, unknown> = {}) {
	return { actionName: "ACTIVATE_PLUGIN_IF_READY", ...extra };
}

export const activatePluginIfReadyAction: Action = {
	name: "ACTIVATE_PLUGIN_IF_READY",
	suppressPostActionContinuation: true,
	similes: ["REGISTER_PLUGIN", "ENABLE_PLUGIN_IF_CONFIGURED"],
	description:
		"Activates a plugin when its required config is satisfied; otherwise reports missing keys.",
	descriptionCompressed:
		"Activate plugin if all required config keys present; else return missing.",
	parameters: [
		{
			name: "pluginName",
			description: "Plugin identifier.",
			required: true,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const { pluginName } = readParams(options);
		if (typeof pluginName !== "string" || pluginName.trim().length === 0) {
			return false;
		}
		return runtime.getService(PLUGIN_CONFIG_CLIENT_SERVICE) !== null;
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const params = readParams(options);
		const pluginName =
			typeof params.pluginName === "string" ? params.pluginName.trim() : "";
		if (!pluginName) {
			return {
				success: false,
				text: "Missing required parameter: pluginName",
				data: dataFor(),
			};
		}

		const client = runtime.getService(
			PLUGIN_CONFIG_CLIENT_SERVICE,
		) as unknown as PluginConfigClient | null;
		if (!client) {
			return {
				success: false,
				text: "PluginConfigClient not available",
				data: dataFor({ pluginName }),
			};
		}

		const status = await client.getStatus(pluginName);
		if (!status) {
			return {
				success: false,
				text: `No manifest registered for plugin '${pluginName}'.`,
				data: dataFor({ pluginName, reason: "no_manifest" }),
			};
		}

		if (!status.ready) {
			logger.info(
				`[ActivatePluginIfReady] plugin=${pluginName} not_ready missing=${status.missing.length}`,
			);
			const text = `Plugin '${pluginName}' is not yet ready. Missing: ${status.missing.join(", ")}.`;
			if (callback) {
				await callback({ text, action: "ACTIVATE_PLUGIN_IF_READY" });
			}
			return {
				success: false,
				text,
				data: dataFor({
					pluginName,
					activated: false,
					reason: "not_ready",
					missing: status.missing,
				}),
			};
		}

		const activated = await client.activate(pluginName);
		if (!activated) {
			logger.info(
				`[ActivatePluginIfReady] plugin=${pluginName} already_registered`,
			);
			return {
				success: false,
				text: `Plugin '${pluginName}' was not activated (already registered or unavailable).`,
				data: dataFor({
					pluginName,
					activated: false,
					reason: "already_registered",
				}),
			};
		}

		const payload: PluginActivatedEventPayload = {
			pluginName,
			at: Date.now(),
		};
		await runtime.emitEvent(
			PLUGIN_ACTIVATED_EVENT,
			payload as unknown as EventPayload,
		);

		logger.info(`[ActivatePluginIfReady] plugin=${pluginName} activated`);

		const text = `Plugin '${pluginName}' activated.`;
		if (callback) {
			await callback({ text, action: "ACTIVATE_PLUGIN_IF_READY" });
		}

		return {
			success: true,
			text,
			data: dataFor({ pluginName, activated: true }),
		};
	},

	examples: [],
};
