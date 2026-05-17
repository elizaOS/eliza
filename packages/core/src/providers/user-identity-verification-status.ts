/**
 * User Identity Verification Status Provider
 *
 * Reports whether the current message author's identity is verified, via a
 * runtime-injected `IdentityVerificationClient` service. Degrades gracefully
 * to `{ verified: false, unverified: true }` (no claim) when the service is
 * absent — never throws.
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

export const IDENTITY_VERIFICATION_CLIENT_SERVICE =
	"IdentityVerificationClient";

export interface IdentityVerificationClient {
	isVerified(identityId: string): Promise<boolean>;
}

export const userIdentityVerificationStatusProvider: Provider = {
	name: "USER_IDENTITY_VERIFICATION_STATUS",
	description:
		"Reports whether the message author's identity is verified (verified, unverified).",
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
			IDENTITY_VERIFICATION_CLIENT_SERVICE,
		) as unknown as IdentityVerificationClient | null;
		const identityId =
			typeof message.entityId === "string" ? message.entityId : undefined;

		if (!client || !identityId) {
			return {
				text: "[Identity] unverified",
				data: { verified: false, unverified: true },
				values: { identityVerified: false },
			};
		}

		const verified = await client.isVerified(identityId);
		return {
			text: verified ? "[Identity] verified" : "[Identity] unverified",
			data: { verified, unverified: !verified },
			values: { identityVerified: verified },
		};
	},
};

export default userIdentityVerificationStatusProvider;
