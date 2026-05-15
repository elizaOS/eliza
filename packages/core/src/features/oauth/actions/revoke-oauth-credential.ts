/**
 * REVOKE_OAUTH_CREDENTIAL — atomic OAuth action.
 *
 * Revokes an OAuth credential previously bound via BIND_OAUTH_CREDENTIAL.
 * Delegates the actual provider-side revocation to the cloud
 * OAuthIntentsClient and reports the result.
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

interface RevokeOAuthCredentialParams {
	oauthIntentId?: unknown;
	reason?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): RevokeOAuthCredentialParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as RevokeOAuthCredentialParams;
	}
	return options as RevokeOAuthCredentialParams;
}

export const revokeOAuthCredentialAction: Action = {
	name: "REVOKE_OAUTH_CREDENTIAL",
	suppressPostActionContinuation: true,
	similes: ["REVOKE_OAUTH", "DISCONNECT_OAUTH"],
	description: "Revoke a previously-bound OAuth credential.",
	descriptionCompressed: "Revoke OAuth credential by intent id.",
	parameters: [
		{
			name: "oauthIntentId",
			description: "ID of the OAuth intent whose credential to revoke.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "reason",
			description: "Optional human-readable revocation reason.",
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
			runtime.getService(OAUTH_INTENTS_CLIENT_SERVICE) !== null &&
			typeof params.oauthIntentId === "string" &&
			params.oauthIntentId.length > 0
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
				data: { actionName: "REVOKE_OAUTH_CREDENTIAL" },
			};
		}
		const oauthIntentId =
			typeof params.oauthIntentId === "string" ? params.oauthIntentId : "";
		if (!oauthIntentId) {
			return {
				success: false,
				text: "Missing required parameter: oauthIntentId",
				data: { actionName: "REVOKE_OAUTH_CREDENTIAL" },
			};
		}
		const reason =
			typeof params.reason === "string" && params.reason.trim().length > 0
				? params.reason.trim()
				: undefined;

		const result = await client.revoke({ oauthIntentId, reason });

		logger.info(
			`[REVOKE_OAUTH_CREDENTIAL] oauthIntentId=${oauthIntentId} revoked=${result.revoked}`,
		);

		const text = result.revoked
			? `Revoked OAuth credential ${oauthIntentId}.`
			: `Failed to revoke OAuth credential ${oauthIntentId}${result.error ? `: ${result.error}` : ""}.`;
		if (callback) {
			await callback({ text, action: "REVOKE_OAUTH_CREDENTIAL" });
		}

		return {
			success: result.revoked,
			text,
			data: { actionName: "REVOKE_OAUTH_CREDENTIAL", revoke: result },
		};
	},

	examples: [],
};
