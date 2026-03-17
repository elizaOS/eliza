/**
 * Tests for autonomy service memory fixes:
 * - Deterministic room ID (derived from agentId)
 * - Circuit breaker with exponential backoff
 * - Memory pruning to bound growth
 * - RECENT_MESSAGES cap for autonomy messages
 */

import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AutonomyService } from "../autonomy/service";
import type { IAgentRuntime, Memory, Task, UUID } from "../types";
import { stringToUuid } from "../utils";

const asUuid = (id: string): UUID => id as UUID;

const makeMemory = (
	id: UUID,
	entityId: UUID,
	roomId: UUID,
	text: string,
	createdAt: number,
): Memory => ({
	id,
	entityId,
	roomId,
	content: { text },
	createdAt,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRuntime(overrides: Partial<IAgentRuntime> = {}) {
	const agentId = asUuid(uuidv4());
	const roomId = asUuid(uuidv4());
	let createdTasks: Task[] = [];
	const deletedMemoryIds: UUID[] = [];

	const runtime = {
		agentId,
		enableAutonomy: false,
		getSetting: (key: string) => {
			if (key === "AUTONOMY_MODE") return "continuous";
			if (key === "AUTONOMY_TARGET_ROOM_ID") return roomId;
			return undefined;
		},
		getMemories: vi.fn(async () => []),
		getRoomsForParticipant: async () => [roomId],
		getRoomsByIds: async () => [{ id: roomId, name: "Test Room" }],
		getMemoriesByRoomIds: async () => [],
		getEntityById: vi.fn(async () => ({ id: agentId, names: ["Test Agent"] })),
		ensureWorldExists: async () => undefined,
		ensureRoomExists: async () => undefined,
		addParticipant: async () => undefined,
		ensureParticipantInRoom: async () => undefined,
		createMemory: vi.fn(async () => asUuid(uuidv4())),
		createEntity: async () => true,
		updateEntity: async () => undefined,
		deleteMemory: vi.fn(async (id: UUID) => {
			deletedMemoryIds.push(id);
		}),
		messageService: {
			handleMessage: vi.fn(async () => ({
				didRespond: true,
				mode: "test",
				responseContent: { actions: [] },
			})),
		},
		emitEvent: async () => undefined,
		registerTaskWorker: vi.fn(),
		getTasks: async () => createdTasks,
		createTask: async (task: Partial<Task>) => {
			const newTask = { ...task, id: asUuid(uuidv4()) } as Task;
			createdTasks.push(newTask);
			return newTask;
		},
		deleteTask: async (id: UUID) => {
			createdTasks = createdTasks.filter((t) => t.id !== id);
		},
		logger: {
			info: vi.fn(),
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		...overrides,
	} as unknown as IAgentRuntime;

	return { runtime, agentId, deletedMemoryIds };
}

/** Extract the registered task worker's execute function. */
function getTaskExecute(
	runtime: IAgentRuntime,
): (
	runtime: IAgentRuntime,
	options: Record<string, unknown>,
	task: Task,
) => Promise<void> {
	const calls = (runtime.registerTaskWorker as ReturnType<typeof vi.fn>).mock
		.calls;
	expect(calls.length).toBeGreaterThan(0);
	const worker = calls[0][0] as {
		execute: (...args: unknown[]) => Promise<void>;
	};
	return worker.execute as (
		runtime: IAgentRuntime,
		options: Record<string, unknown>,
		task: Task,
	) => Promise<void>;
}

// ===========================================================================
// Tests
// ===========================================================================

describe("autonomy service — deterministic room ID", () => {
	test("derives the same room ID for the same agentId across restarts", async () => {
		const agentId = asUuid(uuidv4());

		const { runtime: runtime1 } = createMockRuntime();
		(runtime1 as Record<string, unknown>).agentId = agentId;
		const service1 = await AutonomyService.start(runtime1);
		const roomId1 = service1.getAutonomousRoomId();
		await service1.stop();

		const { runtime: runtime2 } = createMockRuntime();
		(runtime2 as Record<string, unknown>).agentId = agentId;
		const service2 = await AutonomyService.start(runtime2);
		const roomId2 = service2.getAutonomousRoomId();
		await service2.stop();

		expect(roomId1).toBe(roomId2);
		// Verify it's actually derived from agentId
		expect(roomId1).toBe(stringToUuid(`autonomy-room-${agentId}`));
	});

	test("derives different room IDs for different agentIds", async () => {
		const { runtime: runtime1 } = createMockRuntime();
		const service1 = await AutonomyService.start(runtime1);
		const roomId1 = service1.getAutonomousRoomId();
		await service1.stop();

		const { runtime: runtime2 } = createMockRuntime();
		const service2 = await AutonomyService.start(runtime2);
		const roomId2 = service2.getAutonomousRoomId();
		await service2.stop();

		// Different agentIds → different room IDs
		expect(runtime1.agentId).not.toBe(runtime2.agentId);
		expect(roomId1).not.toBe(roomId2);
	});
});

describe("autonomy service — circuit breaker", () => {
	let runtime: IAgentRuntime;
	let service: AutonomyService;
	let execute: ReturnType<typeof getTaskExecute>;
	const dummyTask = { id: asUuid("task-1") } as Task;

	beforeEach(async () => {
		const mock = createMockRuntime();
		runtime = mock.runtime;
		runtime.enableAutonomy = false; // We control execution manually
		service = await AutonomyService.start(runtime);
		execute = getTaskExecute(runtime);
	});

	// To trigger the circuit breaker, errors must escape performAutonomousThink().
	// Errors from messageService.handleMessage are caught internally, so we make
	// getEntityById throw — it's called early without a try/catch wrapper.
	function makeThinkThrow() {
		const getEntityById = runtime.getEntityById as ReturnType<typeof vi.fn>;
		getEntityById.mockRejectedValueOnce(new Error("Out of memory"));
	}

	function makeThinkSucceed() {
		// getEntityById returns a valid entity (default mock already does this,
		// but after a mockRejectedValueOnce the next call uses the original impl).
	}

	test("skips think cycle when in backoff period after a failure", async () => {
		makeThinkThrow();

		// First execution — should fail and set backoff
		await execute(runtime, {}, dummyTask);

		const errorCalls = (runtime.logger.error as ReturnType<typeof vi.fn>).mock
			.calls;
		expect(errorCalls.length).toBeGreaterThanOrEqual(1);

		// Second execution — should be skipped (circuit breaker active)
		const warnBefore = (runtime.logger.warn as ReturnType<typeof vi.fn>).mock
			.calls.length;
		await execute(runtime, {}, dummyTask);
		const warnAfter = (runtime.logger.warn as ReturnType<typeof vi.fn>).mock
			.calls.length;

		// Should have logged a circuit breaker skip warning
		expect(warnAfter).toBeGreaterThan(warnBefore);
		const lastWarnArgs = (runtime.logger.warn as ReturnType<typeof vi.fn>).mock
			.calls[warnAfter - 1];
		expect(lastWarnArgs[1]).toContain("Circuit breaker active");
	});

	test("applies exponential backoff on consecutive failures", async () => {
		makeThinkThrow();
		await execute(runtime, {}, dummyTask);

		// Get the first backoff from the error log
		const errorCalls1 = (runtime.logger.error as ReturnType<typeof vi.fn>).mock
			.calls;
		const firstBackoff = errorCalls1[errorCalls1.length - 1][0]
			.backoffMs as number;
		expect(firstBackoff).toBeGreaterThan(0);

		// Force past the backoff to allow next execution
		const serviceInternal = service as unknown as {
			nextAllowedThinkAt: number;
		};
		serviceInternal.nextAllowedThinkAt = 0;

		makeThinkThrow();
		await execute(runtime, {}, dummyTask);

		const errorCalls2 = (runtime.logger.error as ReturnType<typeof vi.fn>).mock
			.calls;
		const secondBackoff = errorCalls2[errorCalls2.length - 1][0]
			.backoffMs as number;

		// Second backoff should be larger than the first (exponential)
		expect(secondBackoff).toBeGreaterThan(firstBackoff);
	});

	test("caps backoff at 5 minutes", async () => {
		const serviceInternal = service as unknown as {
			nextAllowedThinkAt: number;
			consecutiveFailures: number;
		};

		// Simulate many consecutive failures already recorded
		serviceInternal.consecutiveFailures = 20;
		serviceInternal.nextAllowedThinkAt = 0;

		makeThinkThrow();
		await execute(runtime, {}, dummyTask);

		const errorCalls = (runtime.logger.error as ReturnType<typeof vi.fn>).mock
			.calls;
		const backoffMs = errorCalls[errorCalls.length - 1][0].backoffMs as number;

		// Should be capped at 300_000 (5 minutes)
		expect(backoffMs).toBeLessThanOrEqual(300_000);
	});

	test("resets backoff after successful think", async () => {
		const serviceInternal = service as unknown as {
			nextAllowedThinkAt: number;
			consecutiveFailures: number;
		};

		// First: fail to trigger backoff
		makeThinkThrow();
		await execute(runtime, {}, dummyTask);
		expect(serviceInternal.consecutiveFailures).toBe(1);

		// Reset timer to allow next execution
		serviceInternal.nextAllowedThinkAt = 0;

		// Second: succeed (getEntityById returns valid data by default)
		makeThinkSucceed();
		await execute(runtime, {}, dummyTask);

		// Should be reset
		expect(serviceInternal.consecutiveFailures).toBe(0);
		expect(serviceInternal.nextAllowedThinkAt).toBe(0);
	});
});

describe("autonomy service — memory pruning", () => {
	test("deletes old entries when count exceeds limit (30)", async () => {
		const { runtime, deletedMemoryIds } = createMockRuntime();
		const agentId = runtime.agentId;

		// Generate 50 memories (20 over the limit of 30)
		const memories: Memory[] = [];
		const autonomousRoomId = stringToUuid(`autonomy-room-${agentId}`);
		for (let i = 0; i < 50; i++) {
			memories.push(
				makeMemory(
					asUuid(uuidv4()),
					agentId,
					autonomousRoomId,
					`thought ${i}`,
					i * 1000, // increasing timestamps
				),
			);
		}

		// Mock getMemories to return 50 entries for the autonomy room
		const getMemories = runtime.getMemories as ReturnType<typeof vi.fn>;
		getMemories.mockImplementation(
			async (params: { roomId?: UUID; tableName?: string }) => {
				if (params.roomId === autonomousRoomId) {
					return memories;
				}
				return [];
			},
		);

		runtime.enableAutonomy = false;
		const service = await AutonomyService.start(runtime);

		// Access the private pruneAutonomyMemories method
		const serviceInternal = service as unknown as {
			pruneAutonomyMemories: () => Promise<void>;
		};
		await serviceInternal.pruneAutonomyMemories();

		// Should have deleted 20 entries (50 - 30 = 20) for each table
		// (memories + messages), but since getMemories returns 50 for
		// the autonomy room and 0 for other rooms, we get 20 per table
		// that returns entries. The mock returns 50 for any call with
		// the autonomy roomId, so both tables get pruned.
		expect(deletedMemoryIds.length).toBe(40); // 20 per table × 2 tables

		await service.stop();
	});

	test("skips pruning when entry count is within limit", async () => {
		const { runtime, deletedMemoryIds } = createMockRuntime();
		const agentId = runtime.agentId;
		const autonomousRoomId = stringToUuid(`autonomy-room-${agentId}`);

		// Only 10 memories — well under the 30 limit
		const memories: Memory[] = [];
		for (let i = 0; i < 10; i++) {
			memories.push(
				makeMemory(
					asUuid(uuidv4()),
					agentId,
					autonomousRoomId,
					`thought ${i}`,
					i * 1000,
				),
			);
		}

		const getMemories = runtime.getMemories as ReturnType<typeof vi.fn>;
		getMemories.mockResolvedValue(memories);

		runtime.enableAutonomy = false;
		const service = await AutonomyService.start(runtime);

		const serviceInternal = service as unknown as {
			pruneAutonomyMemories: () => Promise<void>;
		};
		await serviceInternal.pruneAutonomyMemories();

		// Nothing should have been deleted
		expect(deletedMemoryIds.length).toBe(0);

		await service.stop();
	});

	test("pruning runs every 10 successful think cycles", async () => {
		const { runtime } = createMockRuntime();
		runtime.enableAutonomy = false;

		const service = await AutonomyService.start(runtime);
		const execute = getTaskExecute(runtime);
		const dummyTask = { id: asUuid("task-1") } as Task;

		// Mock successful thinks
		const handleMessage = runtime.messageService?.handleMessage as ReturnType<
			typeof vi.fn
		>;
		handleMessage.mockResolvedValue({
			didRespond: true,
			mode: "test",
			responseContent: { actions: [] },
		});

		// getMemories returns empty (nothing to prune)
		const getMemories = runtime.getMemories as ReturnType<typeof vi.fn>;
		getMemories.mockResolvedValue([]);

		// Run 9 cycles — pruning should NOT have been called at the pruning-specific level
		const getMemoriesCallsBefore = getMemories.mock.calls.length;
		for (let i = 0; i < 9; i++) {
			await execute(runtime, {}, dummyTask);
		}

		// The getMemories calls include those from performAutonomousThink itself.
		// Count calls after 9 cycles
		const callsAfter9 = getMemories.mock.calls.length;

		// Run the 10th cycle — this should trigger pruning (extra getMemories calls)
		await execute(runtime, {}, dummyTask);
		const callsAfter10 = getMemories.mock.calls.length;

		// The 10th cycle should have more getMemories calls than cycles 1-9
		// because pruning fetches memories for both "memories" and "messages" tables
		const callsPerNormalCycle = (callsAfter9 - getMemoriesCallsBefore) / 9;
		const callsFor10thCycle = callsAfter10 - callsAfter9;

		// 10th cycle has extra calls for the 2 pruning table fetches
		expect(callsFor10thCycle).toBeGreaterThan(callsPerNormalCycle);

		await service.stop();
	});
});
