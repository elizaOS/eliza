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

describe("ApprovalService.handleTimeout fail-closed classification", () => {
	function createRuntimeWithMocks(): IAgentRuntime {
		return {
			agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
			registerTaskWorker: () => {},
			createTask: async (): Promise<UUID> =>
				`00000000-0000-0000-0000-00000000000${Math.floor(Math.random() * 1000)}` as UUID,
			getTask: async () => null as unknown as never,
			deleteTask: async () => {},
		} as unknown as IAgentRuntime;
	}

	async function captureHandleTimeout(
		request: {
			name: string;
			options: Array<{ name: string; isCancel?: boolean }>;
			timeoutDefault?: string;
		},
	): Promise<{ success: boolean; cancelled: boolean; selectedOption: string }> {
		const runtime = createRuntimeWithMocks();
		const service = new ApprovalService(runtime);
		const taskId = "00000000-0000-0000-0000-000000000099" as UUID;
		let captured: {
			success: boolean;
			cancelled: boolean;
			selectedOption: string;
		} | null = null;
		(runtime as unknown as Record<string, unknown>).deleteTask = async () => {};
		(runtime as unknown as Record<string, unknown>).getTask = async () => null as never;
		// Inject pending entry directly and capture resolve args
		const pending: {
			request: typeof request;
			resolve: (v: {
				success: boolean;
				cancelled: boolean;
				selectedOption: string;
			}) => void;
		} = {
			request: request as never,
			resolve: (v) => {
				captured = v;
			},
		};
		(service as unknown as { pendingApprovals: Map<UUID, unknown> }).pendingApprovals.set(
			taskId,
			pending as never,
		);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await (service as any).handleTimeout(taskId);
		if (!captured) throw new Error("handleTimeout did not resolve");
		return captured;
	}

	it("resolves approve with omitted isCancel as success", async () => {
		const result = await captureHandleTimeout({
			name: "low-risk",
			options: [
				{ name: "approve" },
				{ name: "cancel", isCancel: true },
			],
			timeoutDefault: "approve",
		});
		expect(result).toMatchObject({ selectedOption: "approve", success: true, cancelled: false });
	});

	it("resolves explicit cancel as failure", async () => {
		const result = await captureHandleTimeout({
			name: "x",
			options: [
				{ name: "approve" },
				{ name: "cancel", isCancel: true },
			],
			timeoutDefault: "cancel",
		});
		expect(result).toMatchObject({ selectedOption: "cancel", success: false, cancelled: true });
	});

	it("preserves explicit isCancel:false", async () => {
		const result = await captureHandleTimeout({
			name: "x",
			options: [
				{ name: "confirm", isCancel: false },
				{ name: "cancel", isCancel: true },
			],
			timeoutDefault: "confirm",
		});
		expect(result.success).toBe(true);
		expect(result.cancelled).toBe(false);
	});

	it("fail-closes missing/invalid default as cancelled", async () => {
		const result = await captureHandleTimeout({
			name: "x",
			options: [{ name: "approve" }, { name: "cancel", isCancel: true }],
			timeoutDefault: "typo" as string,
		});
		expect(result).toMatchObject({ selectedOption: "typo", success: false, cancelled: true });
	});
});
