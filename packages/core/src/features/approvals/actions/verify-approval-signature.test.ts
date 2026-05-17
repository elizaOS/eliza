import { describe, expect, test, vi } from "vitest";
import {
	IDENTITY_VERIFICATION_GATEKEEPER_SERVICE,
	type IdentityVerificationGatekeeperClient,
} from "../types";
import { verifyApprovalSignatureAction } from "./verify-approval-signature";

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("VERIFY_APPROVAL_SIGNATURE", () => {
	test("returns valid and signerIdentityId when gatekeeper accepts the signature", async () => {
		const verify = vi
			.fn()
			.mockResolvedValue({ valid: true, signerIdentityId: "0xabc" });
		const gatekeeper: IdentityVerificationGatekeeperClient = {
			verify,
			bindIdentityToSession: vi.fn(),
		};

		const result = await verifyApprovalSignatureAction.handler(
			createRuntime({
				[IDENTITY_VERIFICATION_GATEKEEPER_SERVICE]: gatekeeper,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					approvalRequestId: "appr_1",
					signature: "0xdeadbeef",
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(verify).toHaveBeenCalledWith({
			approvalId: "appr_1",
			signature: "0xdeadbeef",
			expectedSignerIdentityId: undefined,
		});
		expect(result.data?.signerIdentityId).toBe("0xabc");
	});

	test("returns invalid when gatekeeper rejects the signature", async () => {
		const gatekeeper: IdentityVerificationGatekeeperClient = {
			verify: vi
				.fn()
				.mockResolvedValue({ valid: false, error: "bad signature" }),
			bindIdentityToSession: vi.fn(),
		};

		const result = await verifyApprovalSignatureAction.handler(
			createRuntime({
				[IDENTITY_VERIFICATION_GATEKEEPER_SERVICE]: gatekeeper,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					approvalRequestId: "appr_1",
					signature: "0xgarbage",
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(result.data?.valid).toBe(false);
		expect(result.data?.error).toBe("bad signature");
	});

	test("validate fails when gatekeeper service is missing", async () => {
		const ok = await verifyApprovalSignatureAction.validate?.(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					approvalRequestId: "appr_1",
					signature: "0xdeadbeef",
				},
			} as never,
		);
		expect(ok).toBe(false);
	});
});
