/**
 * AWAIT_OAUTH_CALLBACK — atomic OAuth action.
 *
 * Blocks until the OAuthCallbackBus reports a result for the given intent or
 * the timeout elapses. Returns a sanitized callback envelope.
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
	OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
	type OAuthCallbackBusClient,
} from "../types.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface AwaitOAuthCallbackParams {
	oauthIntentId?: unknown;
	timeoutMs?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): AwaitOAuthCallbackParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as AwaitOAuthCallbackParams;
	}
	return options as AwaitOAuthCallbackParams;
}

export const awaitOAuthCallbackAction: Action = {
	name: "AWAIT_OAUTH_CALLBACK",
	suppressPostActionContinuation: true,
	similes: ["WAIT_FOR_OAUTH_CALLBACK", "AWAIT_OAUTH_BIND"],
	description:
		"Wait for the OAuth callback bus to deliver a result for an intent.",
	descriptionCompressed: "Await OAuth callback for an intent id.",
	parameters: [
		{
			name: "oauthIntentId",
			description: "ID of an existing OAuth intent.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "timeoutMs",
			description: "Wait timeout in milliseconds. Defaults to 600000.",
			required: false,
			schema: { type: "number" as const },
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
			runtime.getService(OAUTH_CALLBACK_BUS_CLIENT_SERVICE) !== null &&
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
		const bus = runtime.getService(
			OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
		) as unknown as OAuthCallbackBusClient | null;
		if (!bus) {
			return {
				success: false,
				text: "OAuthCallbackBusClient not available",
				data: { actionName: "AWAIT_OAUTH_CALLBACK" },
			};
		}
		const oauthIntentId =
			typeof params.oauthIntentId === "string" ? params.oauthIntentId : "";
		if (!oauthIntentId) {
			return {
				success: false,
				text: "Missing required parameter: oauthIntentId",
				data: { actionName: "AWAIT_OAUTH_CALLBACK" },
			};
		}

		const timeoutMs =
			typeof params.timeoutMs === "number" &&
			Number.isFinite(params.timeoutMs) &&
			params.timeoutMs > 0
				? params.timeoutMs
				: DEFAULT_TIMEOUT_MS;

		const result = await bus.waitFor(oauthIntentId, timeoutMs);

		logger.info(
			`[AWAIT_OAUTH_CALLBACK] oauthIntentId=${oauthIntentId} status=${result.status}`,
		);

		const sanitized = {
			oauthIntentId: result.oauthIntentId,
			provider: result.provider,
			status: result.status,
			connectorIdentityId: result.connectorIdentityId,
			scopesGranted: result.scopesGranted,
			error: result.error,
			receivedAt: result.receivedAt,
		};

		const text =
			result.status === "bound"
				? `OAuth intent ${oauthIntentId} bound.`
				: `OAuth intent ${oauthIntentId} ended in status ${result.status}${result.error ? `: ${result.error}` : ""}.`;
		if (callback) {
			await callback({ text, action: "AWAIT_OAUTH_CALLBACK" });
		}

		return {
			success: result.status === "bound",
			text,
			data: { actionName: "AWAIT_OAUTH_CALLBACK", callback: sanitized },
		};
	},

	examples: [],
};
