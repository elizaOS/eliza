import { describe, expect, test, vi } from "vitest";
import type { SensitiveRequestDispatchRegistry } from "../../../sensitive-requests/dispatch-registry";
import {
	APPROVAL_REQUESTS_CLIENT_SERVICE,
	type ApprovalRequestEnvelope,
	type ApprovalRequestsClient,
} from "../types";
import { deliverApprovalLinkAction } from "./deliver-approval-link";

const SENSITIVE_DISPATCH_REGISTRY_SERVICE = "SensitiveRequestDispatchRegistry";

function envelope(
	overrides: Partial<ApprovalRequestEnvelope> = {},
): ApprovalRequestEnvelope {
	return {
		approvalRequestId: "appr_1",
		challengeKind: "login",
		challengePayload: { message: "Sign in" },
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

describe("DELIVER_APPROVAL_LINK", () => {
	test("dispatches via the registered adapter for an eligible target", async () => {
		const deliver = vi
			.fn()
			.mockResolvedValue({ delivered: true, target: "dm", channelId: "r1" });
		const adapter = { target: "dm" as const, deliver };
		const registry: SensitiveRequestDispatchRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn().mockReturnValue(adapter),
			list: vi.fn().mockReturnValue([adapter]),
		};
		const client: ApprovalRequestsClient = {
			create: vi.fn(),
			get: vi.fn().mockResolvedValue(envelope()),
			cancel: vi.fn(),
		};

		const result = await deliverApprovalLinkAction.handler(
			createRuntime({
				[APPROVAL_REQUESTS_CLIENT_SERVICE]: client,
				[SENSITIVE_DISPATCH_REGISTRY_SERVICE]: registry,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: {
					approvalRequestId: "appr_1",
					target: "dm",
				},
			} as never,
		);

		expect(result.success).toBe(true);
		expect(deliver).toHaveBeenCalledTimes(1);
		const args = deliver.mock.calls[0][0];
		expect(args.request.id).toBe("appr_1");
		expect(args.request.kind).toBe("approval");
		expect(args.channelId).toBe("r1");
	});

	test("rejects public_link when an expected signer is bound", async () => {
		const adapter = { target: "public_link" as const, deliver: vi.fn() };
		const registry: SensitiveRequestDispatchRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn().mockReturnValue(adapter),
			list: vi.fn().mockReturnValue([adapter]),
		};
		const client: ApprovalRequestsClient = {
			create: vi.fn(),
			get: vi
				.fn()
				.mockResolvedValue(envelope({ expectedSignerIdentityId: "0xabc" })),
			cancel: vi.fn(),
		};

		const result = await deliverApprovalLinkAction.handler(
			createRuntime({
				[APPROVAL_REQUESTS_CLIENT_SERVICE]: client,
				[SENSITIVE_DISPATCH_REGISTRY_SERVICE]: registry,
			}) as never,
			message() as never,
			undefined,
			{
				parameters: { approvalRequestId: "appr_1", target: "public_link" },
			} as never,
		);

		expect(result.success).toBe(false);
		expect(adapter.deliver).not.toHaveBeenCalled();
		expect(result.text).toContain("not eligible");
	});

	test("returns failure when approval request is not found", async () => {
		const registry: SensitiveRequestDispatchRegistry = {
			register: vi.fn(),
			unregister: vi.fn(),
			get: vi.fn(),
			list: vi.fn().mockReturnValue([]),
		};
		const client: ApprovalRequestsClient = {
			create: vi.fn(),
			get: vi.fn().mockResolvedValue(null),
			cancel: vi.fn(),
		};

		const result = await deliverApprovalLinkAction.handler(
			createRuntime({
				[APPROVAL_REQUESTS_CLIENT_SERVICE]: client,
				[SENSITIVE_DISPATCH_REGISTRY_SERVICE]: registry,
			}) as never,
			message() as never,
			undefined,
			{ parameters: { approvalRequestId: "missing", target: "dm" } } as never,
		);

		expect(result.success).toBe(false);
		expect(result.text).toContain("not found");
	});
});
