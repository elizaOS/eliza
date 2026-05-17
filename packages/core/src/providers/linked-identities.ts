/**
 * Linked Identities Provider
 *
 * Lists the linked identities for the current message author, via a
 * runtime-injected `IdentityLinkClient`. Returns `{ identities: [] }` when
 * the client is absent — never throws.
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

export const IDENTITY_LINK_CLIENT_SERVICE = "IdentityLinkClient";

export interface LinkedIdentity {
	identityId: string;
	provider: string;
	verified: boolean;
	label?: string;
}

export interface IdentityLinkClient {
	listLinkedIdentities(identityId: string): Promise<LinkedIdentity[]>;
}

export const linkedIdentitiesProvider: Provider = {
	name: "LINKED_IDENTITIES",
	description: "Lists the linked identities for the current user.",
	position: -10,
	dynamic: true,
	contexts: ["general", "agent_internal"],
	contextGate: { anyOf: ["general", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		const client = runtime.getService(
			IDENTITY_LINK_CLIENT_SERVICE,
		) as unknown as IdentityLinkClient | null;
		const identityId =
			typeof message.entityId === "string" ? message.entityId : undefined;

		if (!client || !identityId) {
			return {
				text: "",
				data: { identities: [] as LinkedIdentity[] },
				values: { linkedIdentityCount: 0 },
			};
		}

		const identities = await client.listLinkedIdentities(identityId);
		const text =
			identities.length === 0
				? ""
				: `[Linked Identities] ${identities
						.map((i) => `${i.provider}${i.verified ? "*" : ""}`)
						.join(", ")}`;

		return {
			text,
			data: { identities },
			values: { linkedIdentityCount: identities.length },
		};
	},
};

export default linkedIdentitiesProvider;
