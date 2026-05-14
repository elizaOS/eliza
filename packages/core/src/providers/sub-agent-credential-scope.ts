/**
 * Sub-Agent Credential Scope Provider
 *
 * When the current runtime is operating as a child / sub-agent, surfaces the
 * scoped credential set assigned to this child session. Resolved via a
 * runtime-injected `CredentialScopeClient`. Returns `{}` when the client is
 * absent or the current runtime is not a child session — never throws.
 *
 * Position: -10.
 */

import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../types/index.ts";

export const CREDENTIAL_SCOPE_CLIENT_SERVICE = "CredentialScopeClient";

export interface CredentialScope {
	childSessionId: string;
	allowedSecrets: string[];
	allowedActions?: string[];
	allowedPlugins?: string[];
	expiresAt?: number;
}

export interface CredentialScopeClient {
	/**
	 * Returns the active credential scope for the current runtime, or `null`
	 * if this runtime is not running as a child session.
	 */
	getCurrentScope(): Promise<CredentialScope | null>;
}

export const subAgentCredentialScopeProvider: Provider = {
	name: "SUB_AGENT_CREDENTIAL_SCOPE",
	description:
		"Reports the active credential scope when this runtime is a sub-agent.",
	position: -10,
	dynamic: true,
	contexts: ["agent_internal", "secrets", "settings"],
	contextGate: { anyOf: ["agent_internal", "secrets", "settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		const client = runtime.getService(
			CREDENTIAL_SCOPE_CLIENT_SERVICE,
		) as unknown as CredentialScopeClient | null;
		if (!client) {
			return { text: "", data: {}, values: {} };
		}

		const scope = await client.getCurrentScope();
		if (!scope) {
			return { text: "", data: {}, values: {} };
		}

		const text = `[Sub-Agent Credential Scope] childSessionId=${
			scope.childSessionId
		} allowedSecrets=${scope.allowedSecrets.length}`;

		return {
			text,
			data: {
				childSessionId: scope.childSessionId,
				scope,
			},
			values: {
				subAgentChildSessionId: scope.childSessionId,
				subAgentAllowedSecretCount: scope.allowedSecrets.length,
			},
		};
	},
};

export default subAgentCredentialScopeProvider;
