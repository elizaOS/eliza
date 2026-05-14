/**
 * POLL_PLUGIN_CONFIG_STATUS — atomic action.
 *
 * Re-probes a plugin via the `PluginConfigClient` and returns a flat
 * `{ ready, missing }` shape. Used between DELIVER and ACTIVATE while the
 * planner waits for the user to fill the dispatched form(s).
 */

import { logger } from "../../../logger.ts";
import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	PLUGIN_CONFIG_CLIENT_SERVICE,
	type PluginConfigClient,
} from "../types.ts";

interface PollParams {
	pluginName?: unknown;
}

function readParams(options: HandlerOptions | undefined): PollParams {
	if (!options?.parameters || typeof options.parameters !== "object") {
		return {};
	}
	return options.parameters as PollParams;
}

function dataFor(extra: Record<string, unknown> = {}) {
	return { actionName: "POLL_PLUGIN_CONFIG_STATUS", ...extra };
}

export const pollPluginConfigStatusAction: Action = {
	name: "POLL_PLUGIN_CONFIG_STATUS",
	suppressPostActionContinuation: true,
	similes: ["CHECK_PLUGIN_READY", "PLUGIN_CONFIG_READY"],
	description:
		"Reports whether a plugin's required config keys are all satisfied.",
	descriptionCompressed:
		"Poll plugin config: ready + missing[].",
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

		logger.info(
			`[PollPluginConfigStatus] plugin=${pluginName} ready=${status.ready} missing=${status.missing.length}`,
		);

		const text = status.ready
			? `Plugin '${pluginName}' is ready.`
			: `Plugin '${pluginName}' still missing: ${status.missing.join(", ")}.`;

		if (callback) {
			await callback({ text, action: "POLL_PLUGIN_CONFIG_STATUS" });
		}

		return {
			success: true,
			text,
			data: dataFor({
				pluginName,
				ready: status.ready,
				missing: status.missing,
			}),
		};
	},

	examples: [],
};
