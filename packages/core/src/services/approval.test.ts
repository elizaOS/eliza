/**
 * Exercises ApprovalService pending-action mapping plus the production
 * timeout and selection cancel classification. Tests drive requestApproval /
 * handleSelection rather than private handleTimeout injection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, UUID } from "../types/index.ts";
import { PENDING_USER_ACTION_WEIGHT } from "../types/index.ts";
import { ApprovalService } from "./approval.ts";

const ROOM_A = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ROOM_B = "00000000-0000-0000-0000-0000000000cc" as UUID;

function createRuntime(): IAgentRuntime {
	const tasks = new Map<UUID, { id: UUID }>();
	let counter = 0;
	return {
		agentId: "00000000-0000-0000-0000-0000000000aa" as UUID,
		registerTaskWorker: () => {},
		createTask: async (): Promise<UUID> => {
			const id = `00000000-0000-0000-0000-00000000000${++counter}` as UUID;
			tasks.set(id, { id });
			return id;
		},
		getTask: async (id: UUID) => tasks.get(id) ?? null,
		deleteTask: async (id: UUID) => {
			tasks.delete(id);
		},
		reportError: () => {},
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
			roomId: ROOM_A,
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
			roomId: ROOM_A,
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
			roomId: ROOM_B,
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

describe("ApprovalService timeout production path", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function settleTimeout(
		request: Parameters<ApprovalService["requestApproval"]>[0],
	) {
		const service = new ApprovalService(createRuntime());
		const pending = service.requestApproval({
			...request,
			description: request.description ?? "timeout case",
			roomId: request.roomId ?? ROOM_A,
			timeoutMs: request.timeoutMs ?? 1_000,
		});
		await vi.advanceTimersByTimeAsync(request.timeoutMs ?? 1_000);
		return pending;
	}

	it("resolves approve with omitted isCancel as success", async () => {
		await expect(
			settleTimeout({
				name: "low-risk",
				description: "ok?",
				roomId: ROOM_A,
				options: [{ name: "approve" }, { name: "cancel", isCancel: true }],
				timeoutDefault: "approve",
			}),
		).resolves.toMatchObject({
			selectedOption: "approve",
			success: true,
			cancelled: false,
			timedOut: true,
		});
	});

	it("resolves explicit cancel as failure", async () => {
		await expect(
			settleTimeout({
				name: "x",
				description: "ok?",
				roomId: ROOM_A,
				options: [{ name: "approve" }, { name: "cancel", isCancel: true }],
				timeoutDefault: "cancel",
			}),
		).resolves.toMatchObject({
			selectedOption: "cancel",
			success: false,
			cancelled: true,
			timedOut: true,
		});
	});

	it("preserves explicit isCancel:false", async () => {
		await expect(
			settleTimeout({
				name: "x",
				description: "ok?",
				roomId: ROOM_A,
				options: [
					{ name: "confirm", isCancel: false },
					{ name: "cancel", isCancel: true },
				],
				timeoutDefault: "confirm",
			}),
		).resolves.toMatchObject({
			selectedOption: "confirm",
			success: true,
			cancelled: false,
			timedOut: true,
		});
	});

	it("fail-closes missing/invalid default as cancelled", async () => {
		await expect(
			settleTimeout({
				name: "x",
				description: "ok?",
				roomId: ROOM_A,
				options: [{ name: "approve" }, { name: "cancel", isCancel: true }],
				timeoutDefault: "typo",
			}),
		).resolves.toMatchObject({
			selectedOption: "typo",
			success: false,
			cancelled: true,
			timedOut: true,
		});
	});
});

describe("ApprovalService.handleSelection fail-closed classification", () => {
	async function settleSelection(
		request: Parameters<ApprovalService["requestApproval"]>[0],
		selectedOption: string,
	) {
		const service = new ApprovalService(createRuntime());
		const pending = service.requestApproval({
			...request,
			description: request.description ?? "selection case",
			roomId: request.roomId ?? ROOM_A,
		});
		let action = service.listPendingUserActions()[0];
		for (let i = 0; i < 50 && !action; i++) {
			await Promise.resolve();
			action = service.listPendingUserActions()[0];
		}
		if (!action) throw new Error("approval was not tracked");
		await service.handleSelection(action.id, selectedOption);
		return pending;
	}

	it("resolves approve with omitted isCancel as success", async () => {
		await expect(
			settleSelection(
				{
					name: "low-risk",
					description: "ok?",
					roomId: ROOM_A,
					options: [{ name: "approve" }, { name: "cancel", isCancel: true }],
				},
				"approve",
			),
		).resolves.toMatchObject({
			selectedOption: "approve",
			success: true,
			cancelled: false,
			timedOut: false,
		});
	});

	it("resolves explicit cancel as failure", async () => {
		await expect(
			settleSelection(
				{
					name: "x",
					description: "ok?",
					roomId: ROOM_A,
					options: [{ name: "approve" }, { name: "cancel", isCancel: true }],
				},
				"cancel",
			),
		).resolves.toMatchObject({
			selectedOption: "cancel",
			success: false,
			cancelled: true,
			timedOut: false,
		});
	});

	it("preserves explicit isCancel:false", async () => {
		await expect(
			settleSelection(
				{
					name: "x",
					description: "ok?",
					roomId: ROOM_A,
					options: [
						{ name: "confirm", isCancel: false },
						{ name: "cancel", isCancel: true },
					],
				},
				"confirm",
			),
		).resolves.toMatchObject({
			selectedOption: "confirm",
			success: true,
			cancelled: false,
			timedOut: false,
		});
	});

	it("fail-closes a missing selection as cancelled", async () => {
		await expect(
			settleSelection(
				{
					name: "x",
					description: "ok?",
					roomId: ROOM_A,
					options: [{ name: "approve" }, { name: "cancel", isCancel: true }],
				},
				"typo",
			),
		).resolves.toMatchObject({
			selectedOption: "typo",
			success: false,
			cancelled: true,
			timedOut: false,
		});
	});

	it("does not treat an ABORT name as cancel without the typed flag", async () => {
		await expect(
			settleSelection(
				{
					name: "x",
					description: "ok?",
					roomId: ROOM_A,
					options: [{ name: "ABORT" }, { name: "cancel", isCancel: true }],
				},
				"ABORT",
			),
		).resolves.toMatchObject({
			selectedOption: "ABORT",
			success: true,
			cancelled: false,
			timedOut: false,
		});
	});
});
