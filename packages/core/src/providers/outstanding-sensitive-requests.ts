/**
 * Outstanding Sensitive Requests Provider
 *
 * Surfaces the user's currently-pending sensitive requests (secrets, oauth,
 * confidential data) via a runtime-injected `SensitiveRequestsClient`.
 * Returns `{ requests: [] }` when the client is absent — never throws.
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

export const SENSITIVE_REQUESTS_CLIENT_SERVICE = "SensitiveRequestsClient";

export interface OutstandingSensitiveRequest {
	id: string;
	kind: string;
	key?: string;
	pluginName?: string;
	createdAt?: number;
	expiresAt?: number;
}

export interface SensitiveRequestsClient {
	listOutstanding(identityId: string): Promise<OutstandingSensitiveRequest[]>;
}

export const outstandingSensitiveRequestsProvider: Provider = {
	name: "OUTSTANDING_SENSITIVE_REQUESTS",
	description:
		"Lists the user's currently-pending sensitive requests (secrets, oauth, etc.).",
	position: -10,
	dynamic: true,
	contexts: ["secrets", "settings", "agent_internal"],
	contextGate: { anyOf: ["secrets", "settings", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		const client = runtime.getService(
			SENSITIVE_REQUESTS_CLIENT_SERVICE,
		) as unknown as SensitiveRequestsClient | null;
		const identityId =
			typeof message.entityId === "string" ? message.entityId : undefined;

		if (!client || !identityId) {
			return {
				text: "",
				data: { requests: [] as OutstandingSensitiveRequest[] },
				values: { outstandingSensitiveRequestCount: 0 },
			};
		}

		const requests = await client.listOutstanding(identityId);
		const text =
			requests.length === 0
				? ""
				: `[Outstanding Sensitive Requests] ${requests.length} pending: ${requests
						.map((r) => r.key ?? r.kind)
						.join(", ")}`;

		return {
			text,
			data: { requests },
			values: { outstandingSensitiveRequestCount: requests.length },
		};
	},
};

export default outstandingSensitiveRequestsProvider;
