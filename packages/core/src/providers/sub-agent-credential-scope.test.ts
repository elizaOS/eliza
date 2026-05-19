import { describe, expect, test } from "vitest";
import { subAgentCredentialScopeProvider } from "./sub-agent-credential-scope";

const message = {
	entityId: "user-1",
	roomId: "room-1",
	content: { text: "" },
};

describe("SUB_AGENT_CREDENTIAL_SCOPE provider", () => {
	test("returns the active credential scope when the runtime is a sub-agent", async () => {
		const client = {
			getCurrentScope: async () => ({
				childSessionId: "child-42",
				allowedSecrets: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"],
			}),
		};
		const runtime = {
			agentId: "agent-1",
			getService: (name: string) =>
				name === "CredentialScopeClient" ? client : null,
		};

		const result = await subAgentCredentialScopeProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);

		const data = result.data as { childSessionId?: string };
		expect(data.childSessionId).toBe("child-42");
	});

	test("returns empty data when client service is absent", async () => {
		const runtime = { agentId: "agent-1", getService: () => null };
		const result = await subAgentCredentialScopeProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);
		expect(result.data).toEqual({});
		expect(result.text).toBe("");
	});

	test("returns empty data when the runtime has no active child scope", async () => {
		const client = { getCurrentScope: async () => null };
		const runtime = {
			agentId: "agent-1",
			getService: (name: string) =>
				name === "CredentialScopeClient" ? client : null,
		};

		const result = await subAgentCredentialScopeProvider.get(
			runtime as never,
			message as never,
			{} as never,
		);
		expect(result.data).toEqual({});
		expect(result.text).toBe("");
	});
});
