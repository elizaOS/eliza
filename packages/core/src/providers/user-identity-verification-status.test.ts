import { describe, expect, test } from "vitest";
import { userIdentityVerificationStatusProvider } from "./user-identity-verification-status";

function createRuntime(client: unknown) {
	return {
		agentId: "agent-1",
		getService: (name: string) =>
			name === "IdentityVerificationClient" ? client : null,
	};
}

const message = {
	entityId: "user-1",
	roomId: "room-1",
	content: { text: "" },
};

describe("USER_IDENTITY_VERIFICATION_STATUS provider", () => {
	test("reports verified=true when client confirms identity", async () => {
		const client = { isVerified: async () => true };
		const result = await userIdentityVerificationStatusProvider.get(
			createRuntime(client) as never,
			message as never,
			{} as never,
		);
		expect(result.data?.verified).toBe(true);
		expect(result.data?.unverified).toBe(false);
	});

	test("falls back to unverified when client service is absent", async () => {
		const runtime = { agentId: "agent-1", getService: () => null };
		const result = await userIdentityVerificationStatusProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);
		expect(result.data?.verified).toBe(false);
		expect(result.data?.unverified).toBe(true);
	});
});
