/**
 * DECLARE_SUB_AGENT_CREDENTIAL_SCOPE — atomic action.
 *
 * Asks the parent-runtime credential bridge to mint a short-lived scope plus
 * a single-use bearer token for the named child session. The token is
 * returned to the planner that called this action so it can hand it to the
 * orchestrator that injects it into the child's sealed environment.
 *
 * The bearer token is NEVER logged. The action's `data` payload includes
 * the token because the caller needs it; that payload is treated as
 * sensitive downstream and must not be persisted into trajectories or
 * action-result clipboards (see `suppressActionResultClipboard`).
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

interface DeclareParams {
	childSessionId?: unknown;
	credentialKeys?: unknown;
	actorPolicy?: unknown;
	deliveryTarget?: unknown;
}

function readParams(options: HandlerOptions | undefined): DeclareParams {
	const params = options?.parameters;
	return params && typeof params === "object" ? (params as DeclareParams) : {};
}

function getBridge(runtime: IAgentRuntime): SubAgentCredentialBridge | null {
	return (runtime.getService(SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE) ??
		null) as unknown as SubAgentCredentialBridge | null;
}

export const declareSubAgentCredentialScopeAction: Action = {
	name: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
	description:
		"Declare a short-lived credential scope for a spawned coding sub-agent. Returns a one-time bearer token plus the request ids dispatched to collect missing values from the owner.",
	descriptionCompressed:
		"Declare scoped one-shot credential bundle for a child coding agent.",
	suppressPostActionContinuation: true,
	suppressActionResultClipboard: true,
	similes: [
		"OPEN_SUB_AGENT_CREDENTIAL_SCOPE",
		"GRANT_SUB_AGENT_CREDENTIALS",
		"PROVISION_SUB_AGENT_SECRETS",
	],
	parameters: [
		{
			name: "childSessionId",
			description: "The PTY session id of the spawned child coding agent.",
			required: true,
			schema: { type: "string" },
		},
		{
			name: "credentialKeys",
			description:
				"Allow-list of credential keys (e.g. ['OPENAI_API_KEY']) the child may pull within this scope.",
			required: true,
			schema: {
				type: "array",
				items: { type: "string" },
			},
		},
		{
			name: "actorPolicy",
			description:
				"Who may approve the credential collection. Defaults to owner_only.",
			required: false,
			schema: {
				type: "string",
				enum: ["owner_only", "owner_or_linked_identity"],
			},
		},
		{
			name: "deliveryTarget",
			description:
				"Where the parent collects the value from the owner. Defaults to owner_app_inline; dm is the fallback.",
			required: false,
			schema: { type: "string", enum: ["dm", "owner_app_inline"] },
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
		if (
			typeof params.childSessionId !== "string" ||
			params.childSessionId.trim().length === 0
		) {
			return false;
		}
		if (
			!Array.isArray(params.credentialKeys) ||
			params.credentialKeys.length === 0
		) {
			return false;
		}
		return true;
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
				data: { actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE" },
			};
		}
		const params = readParams(options);
		const childSessionId =
			typeof params.childSessionId === "string" ? params.childSessionId : "";
		const credentialKeys = Array.isArray(params.credentialKeys)
			? params.credentialKeys.filter(
					(k): k is string => typeof k === "string" && k.trim().length > 0,
				)
			: [];
		if (!childSessionId || credentialKeys.length === 0) {
			return {
				success: false,
				text: "Missing required parameters: childSessionId, credentialKeys",
				data: { actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE" },
			};
		}

		const actorPolicy =
			params.actorPolicy === "owner_or_linked_identity"
				? "owner_or_linked_identity"
				: "owner_only";
		const deliveryTarget =
			params.deliveryTarget === "dm" ? "dm" : "owner_app_inline";

		const scope = await bridge.declareScope({
			childSessionId,
			credentialKeys,
			actorPolicy,
			deliveryTarget,
		});

		logger.info(
			`[SubAgentCreds:declare_scope] childSessionId=${childSessionId} scopeId=${scope.credentialScopeId} keys=${credentialKeys.length}`,
		);

		const text = `Declared credential scope ${scope.credentialScopeId} for ${childSessionId} (${credentialKeys.length} keys).`;
		if (callback) {
			// The scoped token is NEVER surfaced through the user-facing callback —
			// only the scope id and key list. Callers that need the token read it
			// off the action's `data` payload (which the orchestrator handles
			// out-of-band, never persisting it).
			await callback({
				text,
				action: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
				content: {
					credentialScopeId: scope.credentialScopeId,
					expiresAt: scope.expiresAt,
					sensitiveRequestIds: [...scope.sensitiveRequestIds],
					credentialKeys,
				},
			});
		}

		return {
			success: true,
			text,
			data: {
				actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
				credentialScopeId: scope.credentialScopeId,
				scopedToken: scope.scopedToken,
				expiresAt: scope.expiresAt,
				sensitiveRequestIds: [...scope.sensitiveRequestIds],
				credentialKeys,
			},
		};
	},

	examples: [],
};
