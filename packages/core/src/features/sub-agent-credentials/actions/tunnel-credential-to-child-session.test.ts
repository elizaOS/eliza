import { describe, expect, test, vi } from "vitest";
import {
	SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
	type SubAgentCredentialBridge,
} from "../types";
import { tunnelCredentialToChildSessionAction } from "./tunnel-credential-to-child-session";

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("TUNNEL_CREDENTIAL_TO_CHILD_SESSION", () => {
	test("calls bridge.tunnelCredential with the params", async () => {
		const tunnelCredential = vi.fn().mockResolvedValue(undefined);
		const bridge: SubAgentCredentialBridge = {
			declareScope: vi.fn(),
			tunnelCredential,
		};

		const result = await tunnelCredentialToChildSessionAction.handler(
			createRuntime({
				[SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE]: bridge,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					childSessionId: "pty-1-abc",
					credentialScopeId: "cred_scope_a",
					key: "OPENAI_API_KEY",
					value: "sk-test",
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(tunnelCredential).toHaveBeenCalledWith({
			childSessionId: "pty-1-abc",
			credentialScopeId: "cred_scope_a",
			key: "OPENAI_API_KEY",
			value: "sk-test",
		});
		// The plaintext value must NOT appear in the response data.
		expect(JSON.stringify(result.data)).not.toContain("sk-test");
	});

	test("fails when required params are missing", async () => {
		const bridge: SubAgentCredentialBridge = {
			declareScope: vi.fn(),
			tunnelCredential: vi.fn(),
		};
		const result = await tunnelCredentialToChildSessionAction.handler(
			createRuntime({
				[SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE]: bridge,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: { childSessionId: "pty-1-abc" },
			} as never,
		);
		expect(result.success).toBe(false);
	});

	test("validate fails when bridge service is missing", async () => {
		const ok = await tunnelCredentialToChildSessionAction.validate(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					childSessionId: "pty-1-abc",
					credentialScopeId: "cred_scope_a",
					key: "OPENAI_API_KEY",
					value: "sk-test",
				},
			} as never,
		);
		expect(ok).toBe(false);
	});
});
