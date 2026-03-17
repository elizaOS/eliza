/**
 * Tests for ApprovalService
 *
 * Comprehensive tests for the task-based approval system including:
 * - Service lifecycle
 * - Approval request creation
 * - Task worker registration
 * - Option selection handling
 * - Timeout behavior
 * - Cancellation
 * - Callbacks (onSelect, onTimeout)
 * - Async approval requests
 * - Edge cases and error handling
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ApprovalOption,
	ApprovalService,
	STANDARD_OPTIONS,
} from "../services/approval.ts";
import type { IAgentRuntime, Task, UUID } from "../types/index.ts";
import { ServiceType } from "../types/service.ts";
import type { TaskWorker } from "../types/task.ts";

type MockTaskWorker = Pick<TaskWorker, "execute" | "validate">;

// Helper to get task id (avoids non-null assertion in tests)
function getTaskId(tasks: Task[]): UUID {
	const id = tasks[0]?.id;
	if (!id) throw new Error("Expected task to have id");
	return id;
}

function getTaskIdFromTask(task: Task): UUID {
	const id = task.id;
	if (!id) throw new Error("Expected task to have id");
	return id;
}

// Mock runtime factory
function createMockRuntime(): IAgentRuntime & {
	_tasks: Map<UUID, Task>;
	_taskWorkers: Map<string, MockTaskWorker>;
} {
	const tasks = new Map<UUID, Task>();
	const taskWorkers = new Map<string, MockTaskWorker>();
	let taskIdCounter = 0;

	const runtime = {
		agentId: "test-agent-id" as UUID,
		character: { name: "TestAgent" },
		_tasks: tasks,
		_taskWorkers: taskWorkers,

		createTask: vi.fn(async (task: Partial<Task>) => {
			const id = `task-${++taskIdCounter}` as UUID;
			const fullTask: Task = {
				id,
				name: task.name ?? "test-task",
				description: task.description,
				roomId: task.roomId,
				entityId: task.entityId,
				tags: task.tags ?? [],
				metadata: task.metadata ?? {},
				createdAt: Date.now(),
			};
			tasks.set(id, fullTask);
			return id;
		}),

		getTasks: vi.fn(
			async (params: { roomId?: UUID; tags?: string[]; agentIds: UUID[] }) => {
				const result: Task[] = [];
				for (const task of tasks.values()) {
					if (
						task.agentId != null &&
						params.agentIds.length > 0 &&
						!params.agentIds.includes(task.agentId)
					)
						continue;
					if (params.roomId && task.roomId !== params.roomId) continue;
					if (params.tags && !params.tags.every((t) => task.tags?.includes(t)))
						continue;
					result.push(task);
				}
				return result;
			},
		),

		getTask: vi.fn(async (id: UUID) => tasks.get(id) ?? null),

		deleteTask: vi.fn(async (id: UUID) => {
			tasks.delete(id);
		}),

		// Batch task methods (required by IDatabaseAdapter)
		createTasks: vi.fn(async (tasksToCreate: Task[]) => {
			const ids: UUID[] = [];
			for (const task of tasksToCreate) {
				const id = task.id ?? (`task-${++taskIdCounter}` as UUID);
				const fullTask: Task = {
					id,
					name: task.name ?? "test-task",
					description: task.description,
					roomId: task.roomId,
					entityId: task.entityId,
					tags: task.tags ?? [],
					metadata: task.metadata ?? {},
					createdAt: task.createdAt ?? Date.now(),
				};
				tasks.set(id, fullTask);
				ids.push(id);
			}
			return ids;
		}),

		getTasksByIds: vi.fn(async (ids: UUID[]) => {
			return ids.map((id) => tasks.get(id)).filter(Boolean) as Task[];
		}),

		updateTasks: vi.fn(
			async (updates: Array<{ id: UUID; task: Partial<Task> }>) => {
				for (const { id, task: taskUpdate } of updates) {
					const existing = tasks.get(id);
					if (existing) {
						tasks.set(id, { ...existing, ...taskUpdate });
					}
				}
			},
		),

		deleteTasks: vi.fn(async (ids: UUID[]) => {
			for (const id of ids) {
				tasks.delete(id);
			}
		}),

		registerTaskWorker: vi.fn((worker: { name: string } & MockTaskWorker) => {
			taskWorkers.set(worker.name, worker);
		}),

		getTaskWorker: vi.fn((name: string) => taskWorkers.get(name)),

		getService: vi.fn((_type: string) => null),
		getRoom: vi.fn(async (roomId: UUID) => ({
			id: roomId,
			serverId: "test-server",
		})),
	} as unknown as IAgentRuntime & {
		_tasks: Map<UUID, Task>;
		_taskWorkers: Map<string, MockTaskWorker>;
	};

	return runtime;
}

describe("ApprovalService", () => {
	let service: ApprovalService;
	let runtime: ReturnType<typeof createMockRuntime>;

	beforeEach(async () => {
		runtime = createMockRuntime();
		service = (await ApprovalService.start(runtime)) as ApprovalService;
	});

	afterEach(async () => {
		await service.stop();
	});

	// ============================================
	// Service Lifecycle Tests
	// ============================================
	describe("Service lifecycle", () => {
		it("should start and stop correctly", async () => {
			expect(service).toBeInstanceOf(ApprovalService);
			await service.stop();
		});

		it("should have correct service type", () => {
			expect(ApprovalService.serviceType).toBe(ServiceType.APPROVAL);
		});

		it("should have capability description", () => {
			expect(service.capabilityDescription).toBeDefined();
			expect(typeof service.capabilityDescription).toBe("string");
		});

		it("should clear pending approvals on stop", async () => {
			const roomId = "test-room" as UUID;

			// Create an approval that won't complete
			const approvalPromise = service.requestApproval({
				name: "STOP_TEST",
				description: "Test stop cleanup",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 60000, // Long timeout
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Stop the service
			await service.stop();

			// The promise should resolve with cancelled
			const result = await approvalPromise;
			expect(result.cancelled).toBe(true);
		});
	});

	// ============================================
	// Request Approval Tests
	// ============================================
	describe("requestApproval", () => {
		it("should create a task with AWAITING_CHOICE tag", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "TEST_APPROVAL",
				description: "Test approval request",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 1000,
				timeoutDefault: "cancel",
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(runtime.createTask).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "TEST_APPROVAL",
					description: "Test approval request",
					roomId,
					tags: expect.arrayContaining(["AWAITING_CHOICE", "APPROVAL"]),
				}),
			);

			const tasks = await runtime.getTasks({
				roomId,
				tags: ["AWAITING_CHOICE"],
				agentIds: [runtime.agentId],
			});
			expect(tasks.length).toBe(1);

			await service.handleSelection(getTaskId(tasks), "confirm");
			const result = await approvalPromise;
			expect(result.selectedOption).toBe("confirm");
			expect(result.success).toBe(true);
		});

		it("should register task worker for approval type", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "CUSTOM_APPROVAL",
				description: "Custom approval",
				roomId,
				options: STANDARD_OPTIONS.YES_NO,
				timeoutMs: 1000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(runtime.registerTaskWorker).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "CUSTOM_APPROVAL",
				}),
			);

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks), "yes");
			await approvalPromise;
		});

		it("should not re-register worker for same approval type", async () => {
			const roomId = "test-room" as UUID;

			// First request
			const promise1 = service.requestApproval({
				name: "REUSE_WORKER_TEST",
				description: "First request",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 1000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));
			const tasks1 = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks1), "confirm");
			await promise1;

			const registerCallCount1 = (
				runtime.registerTaskWorker as ReturnType<typeof vi.fn>
			).mock.calls.length;

			// Second request with same name
			const promise2 = service.requestApproval({
				name: "REUSE_WORKER_TEST",
				description: "Second request",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 1000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));
			const tasks2 = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks2), "confirm");
			await promise2;

			const registerCallCount2 = (
				runtime.registerTaskWorker as ReturnType<typeof vi.fn>
			).mock.calls.length;

			// Should not have registered again
			expect(registerCallCount2).toBe(registerCallCount1);
		});

		it("should include entityId when provided", async () => {
			const roomId = "test-room" as UUID;
			const entityId = "user-123" as UUID;

			const approvalPromise = service.requestApproval({
				name: "ENTITY_TEST",
				description: "Test with entity",
				roomId,
				entityId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 1000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(runtime.createTask).toHaveBeenCalledWith(
				expect.objectContaining({
					entityId,
				}),
			);

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks), "confirm");
			await approvalPromise;
		});

		it("should include custom metadata", async () => {
			const roomId = "test-room" as UUID;
			const customMetadata = {
				command: "rm -rf /tmp",
				priority: "high",
				requestedBy: "admin",
			};

			const approvalPromise = service.requestApproval({
				name: "METADATA_TEST",
				description: "Test with metadata",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				metadata: customMetadata,
				timeoutMs: 1000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			expect(tasks[0].metadata).toMatchObject(customMetadata);

			await service.handleSelection(getTaskId(tasks), "confirm");
			await approvalPromise;
		});

		it("should handle timeout with default option", async () => {
			const roomId = "test-room" as UUID;

			const result = await service.requestApproval({
				name: "TIMEOUT_TEST",
				description: "Test timeout",
				roomId,
				options: STANDARD_OPTIONS.APPROVE_DENY,
				timeoutMs: 50,
				timeoutDefault: "deny",
			});

			expect(result.timedOut).toBe(true);
			expect(result.selectedOption).toBe("deny");
			expect(result.success).toBe(false);
		});

		it("should default to cancel when no timeoutDefault specified", async () => {
			const roomId = "test-room" as UUID;

			const result = await service.requestApproval({
				name: "TIMEOUT_NO_DEFAULT",
				description: "Test timeout without default",
				roomId,
				options: STANDARD_OPTIONS.APPROVE_DENY,
				timeoutMs: 50,
				// No timeoutDefault
			});

			expect(result.timedOut).toBe(true);
			expect(result.selectedOption).toBe("cancel");
			expect(result.cancelled).toBe(true);
		});

		it("should handle cancellation", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "CANCEL_TEST",
				description: "Test cancellation",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.cancelApproval(getTaskId(tasks));

			const result = await approvalPromise;
			expect(result.cancelled).toBe(true);
			expect(result.success).toBe(false);
			expect(result.selectedOption).toBe("cancel");
		});

		it("should delete task on cancellation", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "CANCEL_DELETE_TEST",
				description: "Test task deletion on cancel",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			const taskId = getTaskId(tasks);
			await service.cancelApproval(taskId);

			await approvalPromise;

			expect(runtime.deleteTask).toHaveBeenCalledWith(taskId);
		});
	});

	// ============================================
	// Handle Selection Tests
	// ============================================
	describe("handleSelection", () => {
		it("should resolve pending approval with selected option", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "SELECT_TEST",
				description: "Test selection",
				roomId,
				options: STANDARD_OPTIONS.ALLOW_ONCE_ALWAYS_DENY,
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks), "allow-always");

			const result = await approvalPromise;
			expect(result.selectedOption).toBe("allow-always");
			expect(result.success).toBe(true);
			expect(result.cancelled).toBe(false);
			expect(result.timedOut).toBe(false);
		});

		it("should mark cancel options as not successful", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "CANCEL_OPTION_TEST",
				description: "Test cancel option",
				roomId,
				options: [
					{ name: "proceed", description: "Continue" },
					{ name: "abort", description: "Stop", isCancel: true },
				],
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks), "abort");

			const result = await approvalPromise;
			expect(result.selectedOption).toBe("abort");
			expect(result.success).toBe(false);
			expect(result.cancelled).toBe(true);
		});

		it("should handle ABORT as cancel", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "ABORT_TEST",
				description: "Test ABORT handling",
				roomId,
				options: [
					{ name: "proceed", description: "Continue" },
					{ name: "stop", description: "Stop" },
				],
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks), "ABORT");

			const result = await approvalPromise;
			expect(result.cancelled).toBe(true);
			expect(result.success).toBe(false);
		});

		it("should include resolvedBy in result", async () => {
			const roomId = "test-room" as UUID;
			const resolvedBy = "user-456" as UUID;

			const approvalPromise = service.requestApproval({
				name: "RESOLVED_BY_TEST",
				description: "Test resolvedBy",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks), "confirm", resolvedBy);

			const result = await approvalPromise;
			expect(result.resolvedBy).toBe(resolvedBy);
		});

		it("should handle selection for unknown task gracefully", async () => {
			// This should not throw
			await service.handleSelection("unknown-task-id" as UUID, "confirm");
		});

		it("should clear timeout when selection is made", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "CLEAR_TIMEOUT_TEST",
				description: "Test timeout clearing",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 100,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks), "confirm");

			const result = await approvalPromise;
			expect(result.timedOut).toBe(false);
			expect(result.selectedOption).toBe("confirm");
		});
	});

	// ============================================
	// Get Pending Approvals Tests
	// ============================================
	describe("getPendingApprovals", () => {
		it("should return pending approvals for a room", async () => {
			const roomId = "test-room" as UUID;

			const promise1 = service.requestApproval({
				name: "APPROVAL_1",
				description: "First approval",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
			});

			const promise2 = service.requestApproval({
				name: "APPROVAL_2",
				description: "Second approval",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const pending = await service.getPendingApprovals(roomId);
			expect(pending.length).toBe(2);

			for (const task of pending) {
				await service.cancelApproval(getTaskIdFromTask(task));
			}
			await promise1.catch(() => {});
			await promise2.catch(() => {});
		});

		it("should return empty array when no pending approvals", async () => {
			const roomId = "empty-room" as UUID;
			const pending = await service.getPendingApprovals(roomId);
			expect(pending).toEqual([]);
		});

		it("should not return approvals from other rooms", async () => {
			const roomId1 = "room-1" as UUID;
			const roomId2 = "room-2" as UUID;

			const promise1 = service.requestApproval({
				name: "ROOM1_APPROVAL",
				description: "Room 1 approval",
				roomId: roomId1,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
			});

			const promise2 = service.requestApproval({
				name: "ROOM2_APPROVAL",
				description: "Room 2 approval",
				roomId: roomId2,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const pendingRoom1 = await service.getPendingApprovals(roomId1);
			const pendingRoom2 = await service.getPendingApprovals(roomId2);

			expect(pendingRoom1.length).toBe(1);
			expect(pendingRoom1[0].name).toBe("ROOM1_APPROVAL");

			expect(pendingRoom2.length).toBe(1);
			expect(pendingRoom2[0].name).toBe("ROOM2_APPROVAL");

			// Cleanup
			for (const task of pendingRoom1)
				await service.cancelApproval(getTaskIdFromTask(task));
			for (const task of pendingRoom2)
				await service.cancelApproval(getTaskIdFromTask(task));
			await promise1.catch(() => {});
			await promise2.catch(() => {});
		});
	});

	// ============================================
	// Callback Tests
	// ============================================
	describe("onSelect callback", () => {
		it("should call onSelect callback when option is selected", async () => {
			const roomId = "test-room" as UUID;
			const onSelectMock = vi.fn();

			const approvalPromise = service.requestApproval({
				name: "CALLBACK_TEST",
				description: "Test callback",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
				onSelect: onSelectMock,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks), "confirm");

			await approvalPromise;

			expect(onSelectMock).toHaveBeenCalledWith(
				"confirm",
				expect.any(Object),
				runtime,
			);
		});

		it("should call onSelect with cancel option when cancelled", async () => {
			const roomId = "test-room" as UUID;
			const onSelectMock = vi.fn();

			const approvalPromise = service.requestApproval({
				name: "CANCEL_CALLBACK_TEST",
				description: "Test cancel callback",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
				onSelect: onSelectMock,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks), "cancel");

			await approvalPromise;

			expect(onSelectMock).toHaveBeenCalledWith(
				"cancel",
				expect.any(Object),
				runtime,
			);
		});

		it("should handle onSelect callback errors gracefully", async () => {
			const roomId = "test-room" as UUID;
			const onSelectMock = vi
				.fn()
				.mockRejectedValue(new Error("Callback error"));

			const approvalPromise = service.requestApproval({
				name: "CALLBACK_ERROR_TEST",
				description: "Test callback error",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
				onSelect: onSelectMock,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});

			// Should not throw
			await service.handleSelection(getTaskId(tasks), "confirm");

			const result = await approvalPromise;
			expect(result.success).toBe(true);
		});
	});

	describe("onTimeout callback", () => {
		it("should call onTimeout callback when approval times out", async () => {
			const roomId = "test-room" as UUID;
			const onTimeoutMock = vi.fn();

			const result = await service.requestApproval({
				name: "TIMEOUT_CALLBACK_TEST",
				description: "Test timeout callback",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 50,
				onTimeout: onTimeoutMock,
			});

			expect(result.timedOut).toBe(true);
			expect(onTimeoutMock).toHaveBeenCalledWith(expect.any(Object), runtime);
		});

		it("should handle onTimeout callback errors gracefully", async () => {
			const roomId = "test-room" as UUID;
			const onTimeoutMock = vi
				.fn()
				.mockRejectedValue(new Error("Timeout callback error"));

			const result = await service.requestApproval({
				name: "TIMEOUT_CALLBACK_ERROR_TEST",
				description: "Test timeout callback error",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 50,
				onTimeout: onTimeoutMock,
			});

			expect(result.timedOut).toBe(true);
		});
	});

	// ============================================
	// Async Approval Tests
	// ============================================
	describe("requestApprovalAsync", () => {
		it("should return task ID immediately", async () => {
			const roomId = "test-room" as UUID;

			const taskId = await service.requestApprovalAsync({
				name: "ASYNC_TEST",
				description: "Test async approval",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
			});

			expect(taskId).toBeDefined();
			expect(typeof taskId).toBe("string");

			// Cleanup
			await service.cancelApproval(taskId);
		});

		it("should call onSelect callback for async approval", async () => {
			const roomId = "test-room" as UUID;
			const onSelectMock = vi.fn();

			const taskId = await service.requestApprovalAsync({
				name: "ASYNC_CALLBACK_TEST",
				description: "Test async callback",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 10000,
				onSelect: onSelectMock,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			await service.handleSelection(taskId, "confirm");

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(onSelectMock).toHaveBeenCalledWith(
				"confirm",
				expect.any(Object),
				runtime,
			);
		});

		it("should call onTimeout callback for async approval", async () => {
			const roomId = "test-room" as UUID;
			const onTimeoutMock = vi.fn();

			await service.requestApprovalAsync({
				name: "ASYNC_TIMEOUT_TEST",
				description: "Test async timeout",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 50,
				onTimeout: onTimeoutMock,
			});

			// Wait for timeout
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(onTimeoutMock).toHaveBeenCalled();
		});
	});

	// ============================================
	// Standard Options Tests
	// ============================================
	describe("STANDARD_OPTIONS", () => {
		it("should have CONFIRM options", () => {
			expect(STANDARD_OPTIONS.CONFIRM).toHaveLength(2);
			expect(STANDARD_OPTIONS.CONFIRM.map((o) => o.name)).toEqual([
				"confirm",
				"cancel",
			]);
			expect(
				STANDARD_OPTIONS.CONFIRM.find((o) => o.name === "cancel")?.isCancel,
			).toBe(true);
		});

		it("should have APPROVE_DENY options", () => {
			expect(STANDARD_OPTIONS.APPROVE_DENY).toHaveLength(2);
			expect(STANDARD_OPTIONS.APPROVE_DENY.map((o) => o.name)).toEqual([
				"approve",
				"deny",
			]);
			expect(
				STANDARD_OPTIONS.APPROVE_DENY.find((o) => o.name === "deny")?.isCancel,
			).toBe(true);
		});

		it("should have YES_NO options", () => {
			expect(STANDARD_OPTIONS.YES_NO).toHaveLength(2);
			expect(STANDARD_OPTIONS.YES_NO.map((o) => o.name)).toEqual(["yes", "no"]);
			expect(
				STANDARD_OPTIONS.YES_NO.find((o) => o.name === "no")?.isCancel,
			).toBe(true);
		});

		it("should have ALLOW_ONCE_ALWAYS_DENY options", () => {
			expect(STANDARD_OPTIONS.ALLOW_ONCE_ALWAYS_DENY).toHaveLength(3);
			expect(
				STANDARD_OPTIONS.ALLOW_ONCE_ALWAYS_DENY.map((o) => o.name),
			).toEqual(["allow-once", "allow-always", "deny"]);
			expect(
				STANDARD_OPTIONS.ALLOW_ONCE_ALWAYS_DENY.find((o) => o.name === "deny")
					?.isCancel,
			).toBe(true);
		});

		it("should have descriptions for all options", () => {
			for (const preset of Object.values(STANDARD_OPTIONS)) {
				for (const option of preset) {
					expect(option.description).toBeDefined();
					expect(typeof option.description).toBe("string");
				}
			}
		});
	});

	// ============================================
	// Custom Options Tests
	// ============================================
	describe("Custom options", () => {
		it("should support many options", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "MANY_OPTIONS_TEST",
				description: "Test many options",
				roomId,
				options: [
					{ name: "option-1", description: "First" },
					{ name: "option-2", description: "Second" },
					{ name: "option-3", description: "Third" },
					{ name: "option-4", description: "Fourth" },
					{ name: "option-5", description: "Fifth" },
				],
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			await service.handleSelection(getTaskId(tasks), "option-3");

			const result = await approvalPromise;
			expect(result.selectedOption).toBe("option-3");
			expect(result.success).toBe(true);
		});

		it("should support default option flag", async () => {
			const roomId = "test-room" as UUID;

			const options: ApprovalOption[] = [
				{ name: "option-a", description: "A" },
				{ name: "option-b", description: "B", isDefault: true },
				{ name: "option-c", description: "C", isCancel: true },
			];

			const approvalPromise = service.requestApproval({
				name: "DEFAULT_OPTION_TEST",
				description: "Test default option",
				roomId,
				options,
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			expect(tasks[0].metadata?.options).toEqual([
				{ name: "option-a", description: "A" },
				{ name: "option-b", description: "B" },
				{ name: "option-c", description: "C" },
			]);

			await service.handleSelection(getTaskId(tasks), "option-b");
			await approvalPromise;
		});
	});

	// ============================================
	// Task Tags Tests
	// ============================================
	describe("Task tags", () => {
		it("should always include AWAITING_CHOICE and APPROVAL tags", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "TAGS_TEST",
				description: "Test tags",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				timeoutMs: 1000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			expect(tasks[0].tags).toContain("AWAITING_CHOICE");
			expect(tasks[0].tags).toContain("APPROVAL");

			await service.handleSelection(getTaskId(tasks), "confirm");
			await approvalPromise;
		});

		it("should support custom tags", async () => {
			const roomId = "test-room" as UUID;

			const approvalPromise = service.requestApproval({
				name: "CUSTOM_TAGS_TEST",
				description: "Test custom tags",
				roomId,
				options: STANDARD_OPTIONS.CONFIRM,
				tags: ["EXEC", "HIGH_PRIORITY", "ADMIN_ONLY"],
				timeoutMs: 10000,
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const tasks = await runtime.getTasks({
				roomId,
				tags: ["EXEC"],
				agentIds: [runtime.agentId],
			});
			expect(tasks.length).toBe(1);
			expect(tasks[0].tags).toContain("AWAITING_CHOICE");
			expect(tasks[0].tags).toContain("APPROVAL");
			expect(tasks[0].tags).toContain("EXEC");
			expect(tasks[0].tags).toContain("HIGH_PRIORITY");
			expect(tasks[0].tags).toContain("ADMIN_ONLY");

			await service.handleSelection(getTaskId(tasks), "confirm");
			await approvalPromise;
		});
	});

	// ============================================
	// Concurrent Approvals Tests
	// ============================================
	describe("Concurrent approvals", () => {
		it("should handle multiple concurrent approvals", async () => {
			const roomId = "test-room" as UUID;

			const promises = [];
			for (let i = 0; i < 5; i++) {
				promises.push(
					service.requestApproval({
						name: `CONCURRENT_${i}`,
						description: `Concurrent approval ${i}`,
						roomId,
						options: STANDARD_OPTIONS.CONFIRM,
						timeoutMs: 10000,
					}),
				);
			}

			await new Promise((resolve) => setTimeout(resolve, 20));

			const tasks = await runtime.getTasks({
				roomId,
				agentIds: [runtime.agentId],
			});
			expect(tasks.length).toBe(5);

			// Resolve each approval
			for (const task of tasks) {
				await service.handleSelection(getTaskIdFromTask(task), "confirm");
			}

			const results = await Promise.all(promises);
			for (const result of results) {
				expect(result.success).toBe(true);
			}
		});
	});
});

// ============================================
// Integration Tests
// ============================================
describe("Task-based Choice System Integration", () => {
	let runtime: ReturnType<typeof createMockRuntime>;

	beforeEach(() => {
		runtime = createMockRuntime();
	});

	it("should create tasks with proper metadata for choices", async () => {
		const service = (await ApprovalService.start(runtime)) as ApprovalService;
		const roomId = "test-room" as UUID;

		const approvalPromise = service.requestApproval({
			name: "CHOICE_METADATA_TEST",
			description: "Test choice metadata",
			roomId,
			options: [
				{ name: "option-a", description: "First option" },
				{ name: "option-b", description: "Second option" },
				{ name: "option-c", description: "Third option" },
			],
			timeoutMs: 10000,
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		const tasks = await runtime.getTasks({
			roomId,
			tags: ["AWAITING_CHOICE"],
			agentIds: [runtime.agentId],
		});
		expect(tasks.length).toBe(1);

		const task = tasks[0];
		expect(task.metadata?.options).toEqual([
			{ name: "option-a", description: "First option" },
			{ name: "option-b", description: "Second option" },
			{ name: "option-c", description: "Third option" },
		]);

		await service.handleSelection(getTaskIdFromTask(task), "option-a");
		await approvalPromise;
		await service.stop();
	});

	it("should store approval request metadata", async () => {
		const service = (await ApprovalService.start(runtime)) as ApprovalService;
		const roomId = "test-room" as UUID;

		const approvalPromise = service.requestApproval({
			name: "APPROVAL_METADATA_TEST",
			description: "Test approval metadata storage",
			roomId,
			options: STANDARD_OPTIONS.CONFIRM,
			timeoutMs: 60000,
			timeoutDefault: "cancel",
			allowedRoles: ["OWNER", "ADMIN"],
		});

		await new Promise((resolve) => setTimeout(resolve, 10));

		const tasks = await runtime.getTasks({
			roomId,
			agentIds: [runtime.agentId],
		});
		const approvalRequest = tasks[0].metadata?.approvalRequest as Record<
			string,
			unknown
		>;

		expect(approvalRequest).toBeDefined();
		expect(approvalRequest.timeoutMs).toBe(60000);
		expect(approvalRequest.timeoutDefault).toBe("cancel");
		expect(approvalRequest.allowedRoles).toEqual(["OWNER", "ADMIN"]);

		await service.handleSelection(getTaskId(tasks), "confirm");
		await approvalPromise;
		await service.stop();
	});
});
