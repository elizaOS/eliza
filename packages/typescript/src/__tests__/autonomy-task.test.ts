import { v4 as uuidv4 } from "uuid";
import { describe, expect, test, vi, beforeEach } from "vitest";
import {
  AutonomyService,
  AUTONOMY_TASK_NAME,
  AUTONOMY_TASK_TAGS,
} from "../autonomy/service";
import type { IAgentRuntime, Memory, Task, UUID } from "../types";

const asTestUuid = (id: string): UUID => id as UUID;

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

describe("autonomy service task-based implementation", () => {
  let mockRuntime: IAgentRuntime;
  let registeredTaskWorkers: Map<string, { name: string; execute: Function }>;
  let createdTasks: Task[];
  let deletedTaskIds: UUID[];

  beforeEach(() => {
    registeredTaskWorkers = new Map();
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
      emitEvent: async () => undefined,
      registerTaskWorker: vi.fn((worker) => {
        registeredTaskWorkers.set(worker.name, worker);
      }),
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

  test("exports task constants", () => {
    expect(AUTONOMY_TASK_NAME).toBe("AUTONOMY_THINK");
    expect(AUTONOMY_TASK_TAGS).toEqual(["repeat", "autonomy", "internal"]);
  });

  test("registers task worker on initialization", async () => {
    const service = await AutonomyService.start(mockRuntime);

    expect(mockRuntime.registerTaskWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        name: AUTONOMY_TASK_NAME,
      }),
    );

    expect(registeredTaskWorkers.has(AUTONOMY_TASK_NAME)).toBe(true);

    await service.stop();
  });

  test("creates recurring task when autonomy is enabled", async () => {
    mockRuntime.enableAutonomy = true;
    const service = await AutonomyService.start(mockRuntime);

    expect(createdTasks.length).toBe(1);
    expect(createdTasks[0].name).toBe(AUTONOMY_TASK_NAME);
    expect(createdTasks[0].tags).toEqual([...AUTONOMY_TASK_TAGS]);
    expect(createdTasks[0].metadata?.blocking).toBe(true);
    expect(createdTasks[0].metadata?.updateInterval).toBe(30000);

    await service.stop();
  });

  test("does not create task when autonomy is disabled", async () => {
    mockRuntime.enableAutonomy = false;
    const service = await AutonomyService.start(mockRuntime);

    expect(createdTasks.length).toBe(0);

    await service.stop();
  });

  test("enableAutonomy creates task", async () => {
    mockRuntime.enableAutonomy = false;
    const service = await AutonomyService.start(mockRuntime);

    expect(createdTasks.length).toBe(0);

    await service.enableAutonomy();

    expect(createdTasks.length).toBe(1);
    expect(service.isLoopRunning()).toBe(true);

    await service.stop();
  });

  test("disableAutonomy deletes task", async () => {
    mockRuntime.enableAutonomy = true;
    const service = await AutonomyService.start(mockRuntime);

    expect(createdTasks.length).toBe(1);
    const taskId = createdTasks[0].id;

    await service.disableAutonomy();

    expect(deletedTaskIds).toContain(taskId);
    expect(service.isLoopRunning()).toBe(false);

    await service.stop();
  });

  test("setLoopInterval recreates task with new interval", async () => {
    mockRuntime.enableAutonomy = true;
    const service = await AutonomyService.start(mockRuntime);

    const originalTaskId = createdTasks[0].id;

    await service.setLoopInterval(60000);

    // Old task should be deleted
    expect(deletedTaskIds).toContain(originalTaskId);

    // New task should be created with new interval
    const newTask = createdTasks.find((t) => t.id !== originalTaskId);
    expect(newTask).toBeDefined();
    expect(newTask?.metadata?.updateInterval).toBe(60000);

    await service.stop();
  });

  test("setLoopInterval clamps values to valid range", async () => {
    const service = await AutonomyService.start(mockRuntime);

    // Test minimum clamping
    await service.setLoopInterval(1000); // Below minimum
    expect(service.getLoopInterval()).toBe(5000);

    // Test maximum clamping
    await service.setLoopInterval(1000000); // Above maximum
    expect(service.getLoopInterval()).toBe(600000);

    await service.stop();
  });

  test("getStatus returns correct status", async () => {
    mockRuntime.enableAutonomy = true;
    const service = await AutonomyService.start(mockRuntime);

    const status = service.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.running).toBe(true);
    expect(status.interval).toBe(30000);
    expect(status.autonomousRoomId).toBeDefined();

    await service.stop();
  });

  test("stop deletes autonomy task", async () => {
    mockRuntime.enableAutonomy = true;
    const service = await AutonomyService.start(mockRuntime);

    const taskId = createdTasks[0].id;

    await service.stop();

    expect(deletedTaskIds).toContain(taskId);
  });

  test("cleans up existing tasks before creating new one", async () => {
    // Simulate existing task
    createdTasks.push({
      id: asTestUuid(uuidv4()),
      name: AUTONOMY_TASK_NAME,
      tags: [...AUTONOMY_TASK_TAGS],
    } as Task);

    mockRuntime.enableAutonomy = true;
    const service = await AutonomyService.start(mockRuntime);

    // Should have deleted old and created new
    expect(deletedTaskIds.length).toBe(1);
    expect(createdTasks.length).toBe(1);

    await service.stop();
  });

  test("task worker executes performAutonomousThink", async () => {
    mockRuntime.enableAutonomy = true;
    const service = await AutonomyService.start(mockRuntime);

    const worker = registeredTaskWorkers.get(AUTONOMY_TASK_NAME);
    expect(worker).toBeDefined();

    // Mock the performAutonomousThink method
    const performSpy = vi
      .spyOn(service, "performAutonomousThink")
      .mockResolvedValue();

    // Execute the task worker
    await worker?.execute(mockRuntime, {}, { id: asTestUuid(uuidv4()) });

    expect(performSpy).toHaveBeenCalled();

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
