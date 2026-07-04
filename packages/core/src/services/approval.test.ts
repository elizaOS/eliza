/**
 * Exercises `ApprovalService.listPendingUserActions`: in-flight async approvals
 * map to canonical `PendingUserAction` records with options, weight, and the
 * self-expiry deadline for timed requests. Runs against a minimal stub runtime.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, UUID } from "../types/index.ts";
import { PENDING_USER_ACTION_WEIGHT } from "../types/index.ts";
import { ApprovalService } from "./approval.ts";

function createRuntime(): IAgentRuntime {
	let counter = 0;
	return {
		agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
		registerTaskWorker: () => {},
		createTask: async (): Promise<UUID> =>
			`00000000-0000-0000-0000-00000000000${++counter}` as UUID,
	} as unknown as IAgentRuntime;
}

describe("ApprovalService.listPendingUserActions", () => {
	it("returns nothing when no approval is in flight", () => {
		const service = new ApprovalService(createRuntime());
		expect(service.listPendingUserActions()).toEqual([]);
	});

	it("maps an in-flight async approval to a canonical PendingUserAction", async () => {
		const service = new ApprovalService(createRuntime());
		const taskId = await service.requestApprovalAsync({
			name: "post-tweet",
			description: "Post this tweet?",
			roomId: "00000000-0000-0000-0000-0000000000bb" as UUID,
			options: [
				{ name: "approve", description: "Send it" },
				{ name: "cancel", description: "Don't send", isCancel: true },
			],
			// onSelect makes requestApprovalAsync track it in the pending map.
			onSelect: async () => {},
		});

		const actions = service.listPendingUserActions();
		expect(actions).toHaveLength(1);
		const action = actions[0];
		expect(action).toMatchObject({
			id: taskId,
			kind: "task_approval",
			source: "approval-service",
			title: "Post this tweet?",
			roomId: "00000000-0000-0000-0000-0000000000bb",
			weight: PENDING_USER_ACTION_WEIGHT.task_approval,
			resolution: {
				target: "approval_service",
				requestId: taskId,
			},
			expiresAt: null,
		});
		expect(action?.options).toEqual([
			{ id: "approve", label: "Send it" },
			{ id: "cancel", label: "Don't send", isCancel: true },
		]);
		expect(typeof action?.createdAt).toBe("number");
	});

	it("carries the self-expiry deadline for a timed approval", async () => {
		const service = new ApprovalService(createRuntime());
		await service.requestApprovalAsync({
			name: "deploy",
			description: "Ship to prod?",
			roomId: "00000000-0000-0000-0000-0000000000cc" as UUID,
			options: [{ name: "ship", description: "Ship it" }],
			timeoutMs: 60_000,
			timeoutDefault: "ship",
			onTimeout: async () => {},
		});

		const [action] = service.listPendingUserActions();
		expect(typeof action?.expiresAt).toBe("number");
		expect(action?.expiresAt ?? 0).toBeGreaterThan(Date.now());

		await service.stop();
	});
});
