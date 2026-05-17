/**
 * BIND_IDENTITY_TO_SESSION — atomic approval action.
 *
 * After an approval has been verified, bind the recovered signer identity to
 * a session via the IdentityVerificationGatekeeper. The gatekeeper persists
 * to session settings when available; otherwise an in-memory binding (Wave H
 * will land the persistent repository).
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
	IDENTITY_VERIFICATION_GATEKEEPER_SERVICE,
	type IdentityVerificationGatekeeperClient,
} from "../types.ts";

interface BindIdentityToSessionParams {
	sessionId?: unknown;
	identityId?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): BindIdentityToSessionParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as BindIdentityToSessionParams;
	}
	return options as BindIdentityToSessionParams;
}

export const bindIdentityToSessionAction: Action = {
	name: "BIND_IDENTITY_TO_SESSION",
	suppressPostActionContinuation: true,
	similes: ["LINK_IDENTITY_TO_SESSION", "ATTACH_IDENTITY_TO_SESSION"],
	description: "Bind a verified signer identity to a session.",
	descriptionCompressed: "Bind verified identity to session.",
	parameters: [
		{
			name: "sessionId",
			description: "Session ID to bind to.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "identityId",
			description: "Verified signer identity id.",
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
		const params = readParams(options);
		return (
			runtime.getService(IDENTITY_VERIFICATION_GATEKEEPER_SERVICE) !== null &&
			typeof params.sessionId === "string" &&
			params.sessionId.length > 0 &&
			typeof params.identityId === "string" &&
			params.identityId.length > 0
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
		const gatekeeper = runtime.getService(
			IDENTITY_VERIFICATION_GATEKEEPER_SERVICE,
		) as unknown as IdentityVerificationGatekeeperClient | null;
		if (!gatekeeper) {
			return {
				success: false,
				text: "IdentityVerificationGatekeeper not available",
				data: { actionName: "BIND_IDENTITY_TO_SESSION" },
			};
		}
		const sessionId =
			typeof params.sessionId === "string" ? params.sessionId : "";
		const identityId =
			typeof params.identityId === "string" ? params.identityId : "";
		if (!sessionId || !identityId) {
			return {
				success: false,
				text: "Missing required parameters: sessionId, identityId",
				data: { actionName: "BIND_IDENTITY_TO_SESSION" },
			};
		}

		await gatekeeper.bindIdentityToSession({ sessionId, identityId });

		logger.info(
			`[BIND_IDENTITY_TO_SESSION] sessionId=${sessionId} identityId=${identityId}`,
		);

		const text = `Bound identity ${identityId} to session ${sessionId}.`;
		if (callback) {
			await callback({ text, action: "BIND_IDENTITY_TO_SESSION" });
		}

		return {
			success: true,
			text,
			data: { actionName: "BIND_IDENTITY_TO_SESSION", sessionId, identityId },
		};
	},

	examples: [],
};
