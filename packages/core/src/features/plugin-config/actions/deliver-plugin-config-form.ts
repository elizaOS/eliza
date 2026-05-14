/**
 * DELIVER_PLUGIN_CONFIG_FORM — atomic action.
 *
 * For every required key currently missing on a plugin, mints a
 * sensitive-request envelope via the `PluginConfigClient` and dispatches it
 * through the `SensitiveRequestDispatchRegistry` to the requested target.
 */

import { logger } from "../../../logger.ts";
import type {
	DeliveryResult,
	DeliveryTarget,
	SensitiveRequestDispatchRegistry,
} from "../../../sensitive-requests/dispatch-registry.ts";
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
	type PluginConfigDeliveryEntry,
} from "../types.ts";

const SENSITIVE_DISPATCH_REGISTRY_SERVICE = "SensitiveRequestDispatchRegistry";

const VALID_TARGETS: ReadonlySet<DeliveryTarget> = new Set<DeliveryTarget>([
	"dm",
	"owner_app_inline",
	"cloud_authenticated_link",
	"tunnel_authenticated_link",
	"public_link",
	"instruct_dm_only",
]);

interface DeliverParams {
	pluginName?: unknown;
	target?: unknown;
	targetChannelId?: unknown;
	reason?: unknown;
}

function readParams(options: HandlerOptions | undefined): DeliverParams {
	if (!options?.parameters || typeof options.parameters !== "object") {
		return {};
	}
	return options.parameters as DeliverParams;
}

function dataFor(extra: Record<string, unknown> = {}) {
	return { actionName: "DELIVER_PLUGIN_CONFIG_FORM", ...extra };
}

export const deliverPluginConfigFormAction: Action = {
	name: "DELIVER_PLUGIN_CONFIG_FORM",
	suppressPostActionContinuation: true,
	similes: ["SEND_PLUGIN_CONFIG_FORM", "REQUEST_PLUGIN_SECRETS"],
	description:
		"Mints and dispatches a sensitive-request per missing required key for a plugin.",
	descriptionCompressed:
		"Dispatch per-key sensitive-request for plugin's missing config keys.",
	parameters: [
		{
			name: "pluginName",
			description: "Plugin identifier.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "target",
			description: "Delivery channel for the config form.",
			required: true,
			schema: {
				type: "string" as const,
				enum: [
					"dm",
					"owner_app_inline",
					"cloud_authenticated_link",
					"tunnel_authenticated_link",
					"public_link",
					"instruct_dm_only",
				],
			},
		},
		{
			name: "targetChannelId",
			description: "Override channel id used by the dispatch adapter.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "reason",
			description:
				"Optional human-readable rationale embedded in each request.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const { pluginName, target } = readParams(options);
		if (typeof pluginName !== "string" || pluginName.trim().length === 0) {
			return false;
		}
		if (
			typeof target !== "string" ||
			!VALID_TARGETS.has(target as DeliveryTarget)
		) {
			return false;
		}
		return (
			runtime.getService(PLUGIN_CONFIG_CLIENT_SERVICE) !== null &&
			runtime.getService(SENSITIVE_DISPATCH_REGISTRY_SERVICE) !== null
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const params = readParams(options);
		const pluginName =
			typeof params.pluginName === "string" ? params.pluginName.trim() : "";
		const target =
			typeof params.target === "string"
				? (params.target as DeliveryTarget)
				: undefined;
		if (!pluginName || !target || !VALID_TARGETS.has(target)) {
			return {
				success: false,
				text: "Missing or invalid parameters: pluginName, target",
				data: dataFor(),
			};
		}

		const client = runtime.getService(
			PLUGIN_CONFIG_CLIENT_SERVICE,
		) as unknown as PluginConfigClient | null;
		const registry = runtime.getService(
			SENSITIVE_DISPATCH_REGISTRY_SERVICE,
		) as unknown as SensitiveRequestDispatchRegistry | null;
		if (!client || !registry) {
			return {
				success: false,
				text: "Plugin-config runtime services not available",
				data: dataFor({ pluginName }),
			};
		}

		const requirements = await client.getRequirements(pluginName);
		if (!requirements) {
			return {
				success: false,
				text: `No manifest registered for plugin '${pluginName}'.`,
				data: dataFor({ pluginName, reason: "no_manifest" }),
			};
		}

		const missingRequired = requirements.missing.filter((k) =>
			requirements.required.includes(k),
		);
		if (missingRequired.length === 0) {
			const text = `Plugin '${pluginName}' has no missing required config keys.`;
			if (callback) {
				await callback({ text, action: "DELIVER_PLUGIN_CONFIG_FORM" });
			}
			return {
				success: true,
				text,
				data: dataFor({ pluginName, entries: [] }),
			};
		}

		const adapter = registry.get(target);
		if (!adapter) {
			return {
				success: false,
				text: `No delivery adapter registered for target ${target}.`,
				data: dataFor({ pluginName, target }),
			};
		}

		const channelId =
			typeof params.targetChannelId === "string" &&
			params.targetChannelId.length > 0
				? params.targetChannelId
				: typeof message.roomId === "string"
					? message.roomId
					: undefined;

		const reason =
			typeof params.reason === "string" && params.reason.trim().length > 0
				? params.reason.trim()
				: undefined;

		const entries: PluginConfigDeliveryEntry[] = [];
		for (const key of missingRequired) {
			const request = await client.createConfigRequest({
				pluginName,
				key,
				reason,
			});
			if (!request) {
				entries.push({
					key,
					requestId: "",
					delivered: false,
					target,
					error: "client_declined",
				});
				continue;
			}

			const result: DeliveryResult = await adapter.deliver({
				request,
				channelId,
				runtime,
			});
			entries.push({
				key,
				requestId: request.id,
				delivered: result.delivered,
				target,
				error: result.error,
			});
		}

		const deliveredCount = entries.filter((e) => e.delivered).length;
		logger.info(
			`[DeliverPluginConfigForm] plugin=${pluginName} target=${target} delivered=${deliveredCount}/${entries.length}`,
		);

		const text = `Dispatched ${deliveredCount}/${entries.length} config request(s) for '${pluginName}' via ${target}.`;
		if (callback) {
			await callback({ text, action: "DELIVER_PLUGIN_CONFIG_FORM" });
		}

		return {
			success: deliveredCount === entries.length,
			text,
			data: dataFor({ pluginName, entries }),
		};
	},

	examples: [],
};
