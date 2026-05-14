/**
 * BIND_OAUTH_CREDENTIAL — atomic OAuth action.
 *
 * Marks an OAuth intent as bound to a specific connector identity, recording
 * the granted scopes. Used after the provider redirect has been validated
 * out-of-band (typically by the cloud callback route) when the action layer
 * needs to explicitly drive the bind transition.
 */

import { logger } from "../../../logger.ts";
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
	OAUTH_INTENTS_CLIENT_SERVICE,
	type OAuthIntentsClient,
} from "../types.ts";

interface BindOAuthCredentialParams {
	oauthIntentId?: unknown;
	connectorIdentityId?: unknown;
	scopesGranted?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): BindOAuthCredentialParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as BindOAuthCredentialParams;
	}
	return options as BindOAuthCredentialParams;
}

export const bindOAuthCredentialAction: Action = {
	name: "BIND_OAUTH_CREDENTIAL",
	suppressPostActionContinuation: true,
	similes: ["CONFIRM_OAUTH_BIND", "FINALIZE_OAUTH_BIND"],
	description:
		"Bind an OAuth intent to a connector identity after the provider callback has been validated.",
	descriptionCompressed: "Bind OAuth intent to connector identity.",
	parameters: [
		{
			name: "oauthIntentId",
			description: "ID of an existing OAuth intent.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "connectorIdentityId",
			description: "Stable connector identity id (provider user id).",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "scopesGranted",
			description: "Scopes the provider actually granted (optional).",
			required: false,
			schema: { type: "array" as const, items: { type: "string" as const } },
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
			runtime.getService(OAUTH_INTENTS_CLIENT_SERVICE) !== null &&
			typeof params.oauthIntentId === "string" &&
			params.oauthIntentId.length > 0 &&
			typeof params.connectorIdentityId === "string" &&
			params.connectorIdentityId.length > 0
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const params = readParams(options);
		const client = runtime.getService(
			OAUTH_INTENTS_CLIENT_SERVICE,
		) as unknown as OAuthIntentsClient | null;
		if (!client) {
			return {
				success: false,
				text: "OAuthIntentsClient not available",
				data: { actionName: "BIND_OAUTH_CREDENTIAL" },
			};
		}
		const oauthIntentId =
			typeof params.oauthIntentId === "string" ? params.oauthIntentId : "";
		const connectorIdentityId =
			typeof params.connectorIdentityId === "string"
				? params.connectorIdentityId
				: "";
		if (!oauthIntentId || !connectorIdentityId) {
			return {
				success: false,
				text: "Missing required parameters: oauthIntentId, connectorIdentityId",
				data: { actionName: "BIND_OAUTH_CREDENTIAL" },
			};
		}

		const scopesGranted = Array.isArray(params.scopesGranted)
			? (params.scopesGranted as unknown[]).filter(
					(s): s is string => typeof s === "string" && s.length > 0,
				)
			: undefined;

		const bind = await client.bind({
			oauthIntentId,
			connectorIdentityId,
			scopesGranted,
		});

		logger.info(
			`[BIND_OAUTH_CREDENTIAL] oauthIntentId=${oauthIntentId} connectorIdentityId=${connectorIdentityId}`,
		);

		const text = `Bound OAuth intent ${oauthIntentId} to ${connectorIdentityId}.`;
		if (callback) {
			await callback({ text, action: "BIND_OAUTH_CREDENTIAL" });
		}

		return {
			success: true,
			text,
			data: { actionName: "BIND_OAUTH_CREDENTIAL", bind },
		};
	},

	examples: [],
};
