import { describe, expect, test, vi } from "vitest";
import {
	APPROVAL_REQUESTS_CLIENT_SERVICE,
	type ApprovalRequestEnvelope,
	type ApprovalRequestsClient,
} from "../types";
import { requestIdentityVerificationAction } from "./request-identity-verification";

function envelope(
	overrides: Partial<ApprovalRequestEnvelope> = {},
): ApprovalRequestEnvelope {
	return {
		approvalRequestId: "appr_1",
		challengeKind: "login",
		challengePayload: { message: "Sign in to Eliza Cloud" },
		expiresAt: Date.now() + 60_000,
		status: "pending",
		...overrides,
	};
}

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("REQUEST_IDENTITY_VERIFICATION", () => {
	test("creates a request and returns eligible delivery targets without expected signer", async () => {
		const create = vi.fn().mockResolvedValue(envelope());
		const callback = vi.fn();
		const client: ApprovalRequestsClient = {
			create,
			get: vi.fn(),
			cancel: vi.fn(),
		};

		const result = await requestIdentityVerificationAction.handler(
			createRuntime({ [APPROVAL_REQUESTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					challengeKind: "login",
					challengePayload: { message: "Sign in to Eliza Cloud" },
				},
			} as never,
			callback,
		);

		expect(result.success).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ action: "REQUEST_IDENTITY_VERIFICATION" }),
		);
		expect(result.data?.approvalRequestId).toBe("appr_1");
		expect(result.data?.eligibleDeliveryTargets).toContain("public_link");
	});

	test("strips public_link when an expected signer is bound", async () => {
		const create = vi
			.fn()
			.mockResolvedValue(envelope({ expectedSignerIdentityId: "0xabc" }));
		const client: ApprovalRequestsClient = {
			create,
			get: vi.fn(),
			cancel: vi.fn(),
		};

		const result = await requestIdentityVerificationAction.handler(
			createRuntime({ [APPROVAL_REQUESTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					challengeKind: "signature",
					challengePayload: {
						message: "approve this",
						signerKind: "wallet",
						walletAddress: "0xabc",
					},
					expectedSignerIdentityId: "0xabc",
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(result.data?.eligibleDeliveryTargets).not.toContain("public_link");
	});

	test("rejects payload missing message", async () => {
		const client: ApprovalRequestsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel: vi.fn(),
		};

		const result = await requestIdentityVerificationAction.handler(
			createRuntime({ [APPROVAL_REQUESTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					challengeKind: "login",
					challengePayload: { signerKind: "wallet", walletAddress: "0xabc" },
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(client.create).not.toHaveBeenCalled();
	});

	test("rejects wallet signer without walletAddress", async () => {
		const client: ApprovalRequestsClient = {
			create: vi.fn(),
			get: vi.fn(),
			cancel: vi.fn(),
		};

		const result = await requestIdentityVerificationAction.handler(
			createRuntime({ [APPROVAL_REQUESTS_CLIENT_SERVICE]: client }) as never,
			message() as never,
			undefined,
			{
				parameters: {
					challengeKind: "signature",
					challengePayload: { message: "x", signerKind: "wallet" },
				},
			} as never,
		);

		expect(result.success).toBe(false);
		expect(client.create).not.toHaveBeenCalled();
	});

	test("validate fails when ApprovalRequestsClient is missing", async () => {
		const ok = await requestIdentityVerificationAction.validate?.(
			createRuntime({}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					challengeKind: "login",
					challengePayload: { message: "x" },
				},
			} as never,
		);
		expect(ok).toBe(false);
	});
});
