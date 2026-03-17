import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	AUTONOMY_TASK_NAME,
	AUTONOMY_TASK_TAGS,
	AutonomyService,
} from "../autonomy/service";
import type { IAgentRuntime, Task, UUID } from "../types";

const asTestUuid = (id: string): UUID => id as UUID;

describe("autonomy service (prompt batcher Option A, no Task)", () => {
	let mockRuntime: IAgentRuntime;
	let thinkCalls: Array<{ id: string; opts: unknown }>;
	let removeSectionCalls: string[];
	let createdTasks: Task[];
	let deletedTaskIds: UUID[];

	beforeEach(() => {
		thinkCalls = [];
		removeSectionCalls = [];
		createdTasks = [];
		deletedTaskIds = [];

		const agentId = asTestUuid(uuidv4());
		const roomId = asTestUuid(uuidv4());

		mockRuntime = {
			agentId,
			enableAutonomy: false,
			getSetting: (key: string) => {
				if (key === "AUTONOMY_MODE") return "continuous";
				if (key === "AUTONOMY_TARGET_ROOM_ID") return roomId;
				return undefined;
			},
			getMemories: async () => [],
			getRoomsForParticipant: async () => [roomId],
			getRoomsForParticipants: async () => [roomId],
			getRoomsByIds: async () => [{ id: roomId, name: "Test Room" }],
			getMemoriesByRoomIds: async () => [],
			getEntityById: async () => ({ id: agentId, names: ["Test Agent"] }),
			ensureWorldExists: async () => undefined,
			ensureRoomExists: async () => undefined,
			addParticipant: async () => undefined,
			ensureParticipantInRoom: async () => undefined,
			createMemory: async () => undefined,
			messageService: {
				handleMessage: async () => ({
					didRespond: true,
					mode: "test",
					responseContent: { actions: [] },
				}),
			},
			promptBatcher: {
				think: vi.fn((id: string, opts: unknown) => {
					thinkCalls.push({ id, opts });
				}),
				removeSection: vi.fn((id: string) => {
					removeSectionCalls.push(id);
				}),
			},
			emitEvent: async () => undefined,
			registerTaskWorker: vi.fn(),
			getTasks: async () => createdTasks,
			createTask: async (task) => {
				const newTask = { ...task, id: asTestUuid(uuidv4()) };
				createdTasks.push(newTask as Task);
				return newTask;
			},
			deleteTask: async (id) => {
				deletedTaskIds.push(id);
				createdTasks = createdTasks.filter((t) => t.id !== id);
			},
			logger: {
				info: vi.fn(),
				debug: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		} as unknown as IAgentRuntime;
	});

	test("exports task constants (used for orphan cleanup)", () => {
		expect(AUTONOMY_TASK_NAME).toBe("AUTONOMY_THINK");
		expect(AUTONOMY_TASK_TAGS).toEqual(["repeat", "autonomy", "internal"]);
	});

	test("does not register task worker on initialization", async () => {
		const service = await AutonomyService.start(mockRuntime);

		expect(mockRuntime.registerTaskWorker).not.toHaveBeenCalled();

		await service.stop();
	});

	test("registers batcher section when autonomy is enabled", async () => {
		(mockRuntime as { enableAutonomy: boolean }).enableAutonomy = true;
		const service = await AutonomyService.start(mockRuntime);

		expect(thinkCalls.length).toBe(1);
		expect(thinkCalls[0].id).toBe("autonomy");
		expect(thinkCalls[0].opts).toMatchObject({
			minCycleMs: 30000,
			preamble: expect.any(String),
			schema: expect.any(Array),
		});

		await service.stop();
	});

	test("does not register section when autonomy is disabled", async () => {
		(mockRuntime as { enableAutonomy: boolean }).enableAutonomy = false;
		const service = await AutonomyService.start(mockRuntime);

		expect(thinkCalls.length).toBe(0);

		await service.stop();
	});

	test("enableAutonomy registers batcher section", async () => {
		(mockRuntime as { enableAutonomy: boolean }).enableAutonomy = false;
		const service = await AutonomyService.start(mockRuntime);

		expect(thinkCalls.length).toBe(0);

		await service.enableAutonomy();

		expect(thinkCalls.length).toBe(1);
		expect(thinkCalls[0].id).toBe("autonomy");
		expect(service.isLoopRunning()).toBe(true);

		await service.stop();
	});

	test("disableAutonomy removes batcher section", async () => {
		(mockRuntime as { enableAutonomy: boolean }).enableAutonomy = true;
		const service = await AutonomyService.start(mockRuntime);

		expect(thinkCalls.length).toBe(1);

		await service.disableAutonomy();

		expect(removeSectionCalls).toContain("autonomy");
		expect(service.isLoopRunning()).toBe(false);

		await service.stop();
	});

	test("setLoopInterval re-registers batcher section with new interval", async () => {
		(mockRuntime as { enableAutonomy: boolean }).enableAutonomy = true;
		const service = await AutonomyService.start(mockRuntime);

		thinkCalls.length = 0;
		removeSectionCalls.length = 0;

		await service.setLoopInterval(60000);

		expect(removeSectionCalls).toContain("autonomy");
		expect(thinkCalls.length).toBe(1);
		expect(thinkCalls[0].opts).toMatchObject({ minCycleMs: 60000 });
		expect(service.getLoopInterval()).toBe(60000);

		await service.stop();
	});

	test("setLoopInterval clamps values to valid range", async () => {
		const service = await AutonomyService.start(mockRuntime);

		await service.setLoopInterval(1000);
		expect(service.getLoopInterval()).toBe(5000);

		await service.setLoopInterval(1000000);
		expect(service.getLoopInterval()).toBe(600000);

		await service.stop();
	});

	test("getStatus returns correct status", async () => {
		(mockRuntime as { enableAutonomy: boolean }).enableAutonomy = true;
		const service = await AutonomyService.start(mockRuntime);

		const status = service.getStatus();

		expect(status.enabled).toBe(true);
		expect(status.running).toBe(true);
		expect(status.interval).toBe(30000);
		expect(status.autonomousRoomId).toBeDefined();

		await service.stop();
	});

	test("stop removes batcher section", async () => {
		(mockRuntime as { enableAutonomy: boolean }).enableAutonomy = true;
		const service = await AutonomyService.start(mockRuntime);

		removeSectionCalls.length = 0;

		await service.stop();

		expect(removeSectionCalls).toContain("autonomy");
	});

	test("cleans up orphaned tasks on init when autonomy enabled", async () => {
		createdTasks.push({
			id: asTestUuid(uuidv4()),
			name: AUTONOMY_TASK_NAME,
			tags: [...AUTONOMY_TASK_TAGS],
		} as Task);

		(mockRuntime as { enableAutonomy: boolean }).enableAutonomy = true;
		const service = await AutonomyService.start(mockRuntime);

		expect(deletedTaskIds.length).toBe(1);
		expect(thinkCalls.length).toBe(1);

		await service.stop();
	});

	test("legacy startLoop/stopLoop methods work", async () => {
		const service = await AutonomyService.start(mockRuntime);

		await service.startLoop();
		expect(service.isLoopRunning()).toBe(true);

		await service.stopLoop();
		expect(service.isLoopRunning()).toBe(false);

		await service.stop();
	});
});
