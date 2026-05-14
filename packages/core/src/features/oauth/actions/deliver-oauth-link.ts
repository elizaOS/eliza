/**
 * DELIVER_OAUTH_LINK — atomic OAuth action.
 *
 * Routes an OAuth authorization link to a chosen channel via
 * SensitiveRequestDispatchRegistry. The actual link contents are taken from
 * the previously-created OAuth intent envelope (hosted URL + provider).
 */

import { logger } from "../../../logger.ts";
import type {
	DeliveryResult,
	DeliveryTarget,
	DispatchSensitiveRequest,
	SensitiveRequestDispatchRegistry,
} from "../../../sensitive-requests/dispatch-registry.ts";
import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	JsonValue,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	eligibleOAuthDeliveryTargets,
	OAUTH_INTENTS_CLIENT_SERVICE,
	type OAuthIntentEnvelope,
	type OAuthIntentsClient,
} from "../types.ts";

const SENSITIVE_DISPATCH_REGISTRY_SERVICE = "SensitiveRequestDispatchRegistry";

const ALL_TARGETS: ReadonlySet<DeliveryTarget> = new Set<DeliveryTarget>([
	"dm",
	"owner_app_inline",
	"cloud_authenticated_link",
	"tunnel_authenticated_link",
	"public_link",
	"instruct_dm_only",
]);

interface DeliverOAuthLinkParams {
	oauthIntentId?: unknown;
	target?: unknown;
	targetChannelId?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): DeliverOAuthLinkParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as DeliverOAuthLinkParams;
	}
	return options as DeliverOAuthLinkParams;
}

function envelopeToDispatchRequest(
	envelope: OAuthIntentEnvelope,
): DispatchSensitiveRequest {
	return {
		id: envelope.oauthIntentId,
		kind: "oauth",
		expiresAt: envelope.expiresAt,
		provider: envelope.provider,
		scopes: envelope.scopes,
		hostedUrl: envelope.hostedUrl,
		status: envelope.status,
	};
}

export const deliverOAuthLinkAction: Action = {
	name: "DELIVER_OAUTH_LINK",
	suppressPostActionContinuation: true,
	similes: ["SEND_OAUTH_LINK", "DISPATCH_OAUTH_LINK"],
	description:
		"Deliver an existing OAuth intent's authorization link via a chosen channel.",
	descriptionCompressed: "Deliver OAuth link via dispatch registry.",
	parameters: [
		{
			name: "oauthIntentId",
			description: "ID of an existing OAuth intent.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "target",
			description: "Delivery target channel.",
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
			description: "Override channel id passed to the delivery adapter.",
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
		const params = readParams(options);
		return (
			runtime.getService(SENSITIVE_DISPATCH_REGISTRY_SERVICE) !== null &&
			runtime.getService(OAUTH_INTENTS_CLIENT_SERVICE) !== null &&
			typeof params.oauthIntentId === "string" &&
			params.oauthIntentId.length > 0 &&
			typeof params.target === "string" &&
			ALL_TARGETS.has(params.target as DeliveryTarget)
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
		const client = runtime.getService(
			OAUTH_INTENTS_CLIENT_SERVICE,
		) as unknown as OAuthIntentsClient | null;
		const registry = runtime.getService(
			SENSITIVE_DISPATCH_REGISTRY_SERVICE,
		) as unknown as SensitiveRequestDispatchRegistry | null;
		if (!client || !registry) {
			return {
				success: false,
				text: "OAuth runtime services not available",
				data: { actionName: "DELIVER_OAUTH_LINK" },
			};
		}
		const oauthIntentId =
			typeof params.oauthIntentId === "string" ? params.oauthIntentId : "";
		const target =
			typeof params.target === "string"
				? (params.target as DeliveryTarget)
				: undefined;
		if (!oauthIntentId || !target || !ALL_TARGETS.has(target)) {
			return {
				success: false,
				text: "Missing or invalid parameters: oauthIntentId, target",
				data: { actionName: "DELIVER_OAUTH_LINK" },
			};
		}

		const envelope = await client.get(oauthIntentId);
		if (!envelope) {
			logger.warn(
				`[DELIVER_OAUTH_LINK] oauthIntentId=${oauthIntentId} not found`,
			);
			return {
				success: false,
				text: `OAuth intent ${oauthIntentId} not found.`,
				data: { actionName: "DELIVER_OAUTH_LINK", oauthIntentId },
			};
		}

		const eligible = eligibleOAuthDeliveryTargets();
		if (!eligible.includes(target)) {
			logger.warn(
				`[DELIVER_OAUTH_LINK] oauthIntentId=${oauthIntentId} ineligible target=${target}`,
			);
			return {
				success: false,
				text: `Delivery target ${target} is not eligible for OAuth intents.`,
				data: {
					actionName: "DELIVER_OAUTH_LINK",
					oauthIntentId,
					eligibleDeliveryTargets: eligible,
				},
			};
		}

		const adapter = registry.get(target);
		if (!adapter) {
			logger.warn(
				`[DELIVER_OAUTH_LINK] oauthIntentId=${oauthIntentId} no adapter for target=${target}`,
			);
			return {
				success: false,
				text: `No delivery adapter registered for target ${target}.`,
				data: { actionName: "DELIVER_OAUTH_LINK", oauthIntentId },
			};
		}

		const channelId =
			typeof params.targetChannelId === "string" &&
			params.targetChannelId.length > 0
				? params.targetChannelId
				: typeof message.roomId === "string"
					? message.roomId
					: undefined;

		const result: DeliveryResult = await adapter.deliver({
			request: envelopeToDispatchRequest(envelope),
			channelId,
			runtime,
		});

		logger.info(
			`[DELIVER_OAUTH_LINK] oauthIntentId=${oauthIntentId} target=${target} delivered=${result.delivered}`,
		);

		const text = result.delivered
			? `Delivered OAuth link ${oauthIntentId} via ${target}.`
			: `Failed to deliver OAuth link ${oauthIntentId} via ${target}${result.error ? `: ${result.error}` : ""}.`;
		if (callback) {
			await callback({ text, action: "DELIVER_OAUTH_LINK" });
		}

		return {
			success: result.delivered,
			text,
			data: {
				actionName: "DELIVER_OAUTH_LINK",
				oauthIntentId,
				target,
				deliveryResult: result,
			},
		};
	},

	examples: [],
};
