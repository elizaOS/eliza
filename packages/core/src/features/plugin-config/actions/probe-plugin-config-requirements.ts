/**
 * PROBE_PLUGIN_CONFIG_REQUIREMENTS — atomic action.
 *
 * Reads a plugin's declared `requiredSecrets[]` / `optionalSecrets[]` via
 * the runtime-injected `PluginConfigClient` and reports which keys are
 * currently present vs. missing. Does not collect, deliver, or activate.
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

interface ProbeParams {
	pluginName?: unknown;
}

function readParams(options: HandlerOptions | undefined): ProbeParams {
	if (!options?.parameters || typeof options.parameters !== "object") {
		return {};
	}
	return options.parameters as ProbeParams;
}

function dataFor(extra: Record<string, unknown> = {}) {
	return { actionName: "PROBE_PLUGIN_CONFIG_REQUIREMENTS", ...extra };
}

export const probePluginConfigRequirementsAction: Action = {
	name: "PROBE_PLUGIN_CONFIG_REQUIREMENTS",
	suppressPostActionContinuation: true,
	similes: ["CHECK_PLUGIN_CONFIG", "INSPECT_PLUGIN_REQUIREMENTS"],
	description:
		"Reports a plugin's declared required/optional config keys and which are present vs. missing.",
	descriptionCompressed:
		"Probe plugin's required/optional config keys → present, missing.",
	parameters: [
		{
			name: "pluginName",
			description: "Plugin identifier (e.g. anthropic, discord).",
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

		const requirements = await client.getRequirements(pluginName);
		if (!requirements) {
			logger.warn(
				`[ProbePluginConfigRequirements] no manifest for plugin=${pluginName}`,
			);
			return {
				success: false,
				text: `No manifest registered for plugin '${pluginName}'.`,
				data: dataFor({ pluginName, reason: "no_manifest" }),
			};
		}

		logger.info(
			`[ProbePluginConfigRequirements] plugin=${pluginName} required=${requirements.required.length} missing=${requirements.missing.length}`,
		);

		const text =
			requirements.missing.length === 0
				? `Plugin '${pluginName}' has all required config keys.`
				: `Plugin '${pluginName}' is missing: ${requirements.missing.join(", ")}.`;

		if (callback) {
			await callback({ text, action: "PROBE_PLUGIN_CONFIG_REQUIREMENTS" });
		}

		return {
			success: true,
			text,
			data: dataFor({
				pluginName,
				required: requirements.required,
				optional: requirements.optional,
				present: requirements.present,
				missing: requirements.missing,
			}),
		};
	},

	examples: [],
};
