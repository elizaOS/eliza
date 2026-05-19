/**
 * TUNNEL_CREDENTIAL_TO_CHILD_SESSION — atomic action.
 *
 * Once the parent has collected the credential value from the owner (via the
 * sensitive-request flow that was dispatched by
 * `DECLARE_SUB_AGENT_CREDENTIAL_SCOPE`), this action hands the plaintext
 * value to the credential bridge, which encrypts it under the scope's
 * symmetric key and stores the ciphertext for one-shot retrieval by the
 * child.
 *
 * The plaintext credential value is NEVER logged. The action's `data`
 * response only contains the scope id and key name.
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
	SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
	type SubAgentCredentialBridge,
} from "../types.ts";

interface TunnelParams {
	childSessionId?: unknown;
	credentialScopeId?: unknown;
	key?: unknown;
	value?: unknown;
}

function readParams(options: HandlerOptions | undefined): TunnelParams {
	const params = options?.parameters;
	return params && typeof params === "object" ? (params as TunnelParams) : {};
}

function getBridge(runtime: IAgentRuntime): SubAgentCredentialBridge | null {
	return (runtime.getService(SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE) ??
		null) as unknown as SubAgentCredentialBridge | null;
}

export const tunnelCredentialToChildSessionAction: Action = {
	name: "TUNNEL_CREDENTIAL_TO_CHILD_SESSION",
	description:
		"Encrypt and stage a credential value under the named scope so the child can retrieve it once.",
	descriptionCompressed: "Stage credential ciphertext for a child sub-agent.",
	suppressPostActionContinuation: true,
	suppressActionResultClipboard: true,
	similes: [
		"STAGE_SUB_AGENT_CREDENTIAL",
		"DELIVER_SUB_AGENT_CREDENTIAL",
		"PROVIDE_SUB_AGENT_CREDENTIAL",
	],
	parameters: [
		{
			name: "childSessionId",
			description: "PTY session id of the spawned child coding agent.",
			required: true,
			schema: { type: "string" },
		},
		{
			name: "credentialScopeId",
			description: "Scope id returned by DECLARE_SUB_AGENT_CREDENTIAL_SCOPE.",
			required: true,
			schema: { type: "string" },
		},
		{
			name: "key",
			description:
				"Credential key being delivered. Must be in the scope's allow-list.",
			required: true,
			schema: { type: "string" },
		},
		{
			name: "value",
			description: "Plaintext credential value. Never logged.",
			required: true,
			schema: { type: "string" },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (!getBridge(runtime)) return false;
		const params = readParams(options);
		return (
			typeof params.childSessionId === "string" &&
			params.childSessionId.length > 0 &&
			typeof params.credentialScopeId === "string" &&
			params.credentialScopeId.length > 0 &&
			typeof params.key === "string" &&
			params.key.length > 0 &&
			typeof params.value === "string" &&
			params.value.length > 0
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const bridge = getBridge(runtime);
		if (!bridge) {
			return {
				success: false,
				text: "SubAgentCredentialBridge service not available",
				data: { actionName: "TUNNEL_CREDENTIAL_TO_CHILD_SESSION" },
			};
		}
		const params = readParams(options);
		const childSessionId =
			typeof params.childSessionId === "string" ? params.childSessionId : "";
		const credentialScopeId =
			typeof params.credentialScopeId === "string"
				? params.credentialScopeId
				: "";
		const key = typeof params.key === "string" ? params.key : "";
		const value = typeof params.value === "string" ? params.value : "";
		if (!childSessionId || !credentialScopeId || !key || !value) {
			return {
				success: false,
				text: "Missing required parameters: childSessionId, credentialScopeId, key, value",
				data: { actionName: "TUNNEL_CREDENTIAL_TO_CHILD_SESSION" },
			};
		}

		await bridge.tunnelCredential({
			childSessionId,
			credentialScopeId,
			key,
			value,
		});

		logger.info(
			`[SubAgentCreds:tunnel] childSessionId=${childSessionId} scopeId=${credentialScopeId} key=${key}`,
		);

		const text = `Staged ${key} for ${childSessionId} on scope ${credentialScopeId}.`;
		if (callback) {
			await callback({
				text,
				action: "TUNNEL_CREDENTIAL_TO_CHILD_SESSION",
				content: { childSessionId, credentialScopeId, key },
			});
		}

		return {
			success: true,
			text,
			data: {
				actionName: "TUNNEL_CREDENTIAL_TO_CHILD_SESSION",
				childSessionId,
				credentialScopeId,
				key,
			},
		};
	},

	examples: [],
};
