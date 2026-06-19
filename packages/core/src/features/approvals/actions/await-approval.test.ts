import { describe, expect, test, vi } from "vitest";
import {
	APPROVAL_CALLBACK_BUS_CLIENT_SERVICE,
	type ApprovalCallbackBusClient,
} from "../types";
import { awaitApprovalAction } from "./await-approval";

function createRuntime(services: Record<string, unknown | null>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => services[name] ?? null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

describe("AWAIT_APPROVAL", () => {
	test("returns sanitized callback envelope when approved", async () => {
		const waitFor = vi.fn().mockResolvedValue({
			approvalRequestId: "appr_1",
			status: "approved",
			signerIdentityId: "0xabc",
			signatureText: "0xdeadbeef",
			receivedAt: 123,
		});
		const bus: ApprovalCallbackBusClient = { waitFor };

		const result = await awaitApprovalAction.handler(
			createRuntime({ [APPROVAL_CALLBACK_BUS_CLIENT_SERVICE]: bus }) as never,
			message() as never,
			undefined,
			{
				parameters: { approvalRequestId: "appr_1", timeoutMs: 1000 },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(waitFor).toHaveBeenCalledWith("appr_1", 1000);
		const callback = result.data?.callback as Record<string, unknown>;
		expect(callback.signerIdentityId).toBe("0xabc");
		expect(callback).not.toHaveProperty("signatureText");
	});

	test("uses default timeout when not provided", async () => {
		const waitFor = vi.fn().mockResolvedValue({
			approvalRequestId: "appr_1",
			status: "expired",
		});
		const bus: ApprovalCallbackBusClient = { waitFor };

		await awaitApprovalAction.handler(
			createRuntime({ [APPROVAL_CALLBACK_BUS_CLIENT_SERVICE]: bus }) as never,
			message() as never,
			undefined,
			{ parameters: { approvalRequestId: "appr_1" } } as never,
		);

		expect(waitFor).toHaveBeenCalledWith("appr_1", 10 * 60 * 1000);
	});

	test("returns failure for non-approved terminal status", async () => {
		const bus: ApprovalCallbackBusClient = {
			waitFor: vi.fn().mockResolvedValue({
				approvalRequestId: "appr_1",
				status: "denied",
			}),
		};

		const result = await awaitApprovalAction.handler(
			createRuntime({ [APPROVAL_CALLBACK_BUS_CLIENT_SERVICE]: bus }) as never,
			message() as never,
			undefined,
			{ parameters: { approvalRequestId: "appr_1" } } as never,
		);

		expect(result.success).toBe(false);
	});
});
