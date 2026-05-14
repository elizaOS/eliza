import { describe, expect, test, vi } from "vitest";
import {
	SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE,
	type SubAgentCredentialBridge,
} from "../types";
import { declareSubAgentCredentialScopeAction } from "./declare-sub-agent-credential-scope";

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("DECLARE_SUB_AGENT_CREDENTIAL_SCOPE", () => {
	test("calls bridge.declareScope and returns scope id + token", async () => {
		const declareScope = vi.fn().mockResolvedValue({
			credentialScopeId: "cred_scope_abc",
			scopedToken: "deadbeef",
			expiresAt: 1234567890,
			sensitiveRequestIds: ["req_1"],
		});
		const bridge: SubAgentCredentialBridge = {
			declareScope,
			tunnelCredential: vi.fn(),
		};
		const callback = vi.fn();

		const result = await declareSubAgentCredentialScopeAction.handler(
			createRuntime({
				[SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE]: bridge,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					childSessionId: "pty-1-abc",
					credentialKeys: ["OPENAI_API_KEY"],
				},
			} as never,
			callback,
		);

		expect(result.success).toBe(true);
		expect(declareScope).toHaveBeenCalledWith({
			childSessionId: "pty-1-abc",
			credentialKeys: ["OPENAI_API_KEY"],
			actorPolicy: "owner_only",
			deliveryTarget: "owner_app_inline",
		});
		expect(result.data?.credentialScopeId).toBe("cred_scope_abc");
		expect(result.data?.scopedToken).toBe("deadbeef");
		// The token must NOT leak through the user-facing callback.
		expect(callback).toHaveBeenCalledTimes(1);
		const callbackArg = callback.mock.calls[0]?.[0] as {
			content?: Record<string, unknown>;
		};
		expect(callbackArg.content?.scopedToken).toBeUndefined();
		expect(callbackArg.content?.credentialScopeId).toBe("cred_scope_abc");
	});

	test("validate fails when bridge service is missing", async () => {
		const ok = await declareSubAgentCredentialScopeAction.validate(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					childSessionId: "pty-1-abc",
					credentialKeys: ["OPENAI_API_KEY"],
				},
			} as never,
		);
		expect(ok).toBe(false);
	});

	test("validate fails when credentialKeys is empty", async () => {
		const bridge: SubAgentCredentialBridge = {
			declareScope: vi.fn(),
			tunnelCredential: vi.fn(),
		};
		const ok = await declareSubAgentCredentialScopeAction.validate(
			createRuntime({
				[SUB_AGENT_CREDENTIAL_BRIDGE_SERVICE]: bridge,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: { childSessionId: "pty-1-abc", credentialKeys: [] },
			} as never,
		);
		expect(ok).toBe(false);
	});

	test("missing service surfaces a service-unavailable error from handler", async () => {
		const result = await declareSubAgentCredentialScopeAction.handler(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					childSessionId: "pty-1-abc",
					credentialKeys: ["OPENAI_API_KEY"],
				},
			} as never,
		);
		expect(result.success).toBe(false);
		expect(result.text).toContain("not available");
	});
});
