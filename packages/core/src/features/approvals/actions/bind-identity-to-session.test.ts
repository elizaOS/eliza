import { describe, expect, test, vi } from "vitest";
import {
	IDENTITY_VERIFICATION_GATEKEEPER_SERVICE,
	type IdentityVerificationGatekeeperClient,
} from "../types";
import { bindIdentityToSessionAction } from "./bind-identity-to-session";

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("BIND_IDENTITY_TO_SESSION", () => {
	test("binds an identity to a session via the gatekeeper", async () => {
		const bind = vi.fn().mockResolvedValue(undefined);
		const gatekeeper: IdentityVerificationGatekeeperClient = {
			verify: vi.fn(),
			bindIdentityToSession: bind,
		};

		const result = await bindIdentityToSessionAction.handler(
			createRuntime({
				[IDENTITY_VERIFICATION_GATEKEEPER_SERVICE]: gatekeeper,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: { sessionId: "sess-1", identityId: "0xabc" },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(bind).toHaveBeenCalledWith({
			sessionId: "sess-1",
			identityId: "0xabc",
		});
		expect(result.data?.sessionId).toBe("sess-1");
		expect(result.data?.identityId).toBe("0xabc");
	});

	test("returns failure when parameters are missing", async () => {
		const gatekeeper: IdentityVerificationGatekeeperClient = {
			verify: vi.fn(),
			bindIdentityToSession: vi.fn(),
		};

		const result = await bindIdentityToSessionAction.handler(
			createRuntime({
				[IDENTITY_VERIFICATION_GATEKEEPER_SERVICE]: gatekeeper,
			}) as never,
			message() as never,
			undefined,
			{ parameters: { sessionId: "sess-1" } } as never,
		);

		expect(result.success).toBe(false);
		expect(gatekeeper.bindIdentityToSession).not.toHaveBeenCalled();
	});

	test("validate fails when gatekeeper is missing", async () => {
		const ok = await bindIdentityToSessionAction.validate?.(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{
				parameters: { sessionId: "sess-1", identityId: "0xabc" },
			} as never,
		);
		expect(ok).toBe(false);
	});
});
