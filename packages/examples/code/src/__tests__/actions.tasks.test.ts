import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type Room,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core";
import {
  type AgentProvider,
  AgentOrchestratorService as CodeTaskService,
  cancelTaskAction,
  configureAgentOrchestratorPlugin,
  createTaskAction,
  listTasksAction,
  type OrchestratedTask,
  type ProviderTaskExecutionContext,
  pauseTaskAction,
  resumeTaskAction,
  searchTasksAction,
  switchTaskAction,
  type TaskResult,
} from "@elizaos/plugin-agent-orchestrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CodeTask, CodeTaskMetadata } from "../types.js";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils.js";

function createMemory(text: string, roomId?: UUID): Memory {
  return {
    content: { text },
    roomId,
  } as Memory;
}

describe("plugin actions: task management", () => {
  let runtime: IAgentRuntime;
  let service: CodeTaskService;
  let roomId: UUID;

  // In-memory stores for testing
  let tasks: Map<string, CodeTask>;
  let rooms: Map<string, Room>;
  let taskCounter: number;
  let serviceRef: CodeTaskService | null;

  beforeEach(async () => {
    process.env.ELIZA_CODE_ACTIVE_SUB_AGENT = "eliza";

    runtime = await createTestRuntime();
    tasks = new Map();
    rooms = new Map();
    taskCounter = 0;
    serviceRef = null;

    // Default room
    const defaultRoomId = stringToUuid("test-room");
    const defaultWorldId = stringToUuid("test-world");
    roomId = defaultRoomId;
    rooms.set(defaultRoomId, {
      id: defaultRoomId,
      source: "test",
      type: ChannelType.DM,
      worldId: defaultWorldId,
      name: "Test Room",
    });

    // Spy on runtime methods
    vi.spyOn(runtime, "getRoom").mockImplementation(
      async (id: UUID) => rooms.get(id) ?? null,
    );

    // Mock getMemories to return empty array (avoids database queries)
    vi.spyOn(runtime, "getMemories").mockResolvedValue([]);

    const noOpProvider: AgentProvider = {
      id: "eliza",
      label: "Test Provider",
      executeTask: async (
        _task: OrchestratedTask,
        _ctx: ProviderTaskExecutionContext,
      ): Promise<TaskResult> => ({
        success: true,
        summary: "noop",
        filesCreated: [],
        filesModified: [],
      }),
    };
    configureAgentOrchestratorPlugin({
      providers: [noOpProvider],
      defaultProviderId: "eliza",
      getWorkingDirectory: () => process.cwd(),
      activeProviderEnvVar: "ELIZA_CODE_ACTIVE_SUB_AGENT",
    });

    vi.spyOn(runtime, "getService").mockImplementation(
      <T>(type: string): T | null => {
        if (type === "CODE_TASK") return serviceRef as T;
        return null;
      },
    );

    vi.spyOn(runtime, "createTask").mockImplementation(async (task: Task) => {
      taskCounter += 1;
      const id = stringToUuid(`task-${taskCounter}`);

      const fullTask: CodeTask = {
        id,
        name: task.name,
        description: task.description,
        tags: task.tags,
        roomId: task.roomId,
        worldId: task.worldId,
        metadata: (task.metadata ?? {}) as CodeTaskMetadata,
      };

      tasks.set(id, fullTask);
      return id;
    });

    vi.spyOn(runtime, "getTask").mockImplementation(
      async (id: UUID) => tasks.get(id) ?? null,
    );

    vi.spyOn(runtime, "getTasks").mockImplementation(
      async ({ tags }: { tags?: string[] }) => {
        const allTasks = Array.from(tasks.values());
        if (!tags || tags.length === 0) return allTasks;
        return allTasks.filter((t) =>
          tags.some((tag) => t.tags?.includes(tag)),
        );
      },
    );

    vi.spyOn(runtime, "updateTask").mockImplementation(
      async (id: UUID, updates: Partial<Task>) => {
        const task = tasks.get(id);
        if (!task) return;

        if (typeof updates.name === "string") task.name = updates.name;
        if (typeof updates.description === "string")
          task.description = updates.description;
        if (Array.isArray(updates.tags)) task.tags = updates.tags;
        if (updates.roomId) task.roomId = updates.roomId;
        if (updates.worldId) task.worldId = updates.worldId;
        if (updates.metadata) {
          task.metadata = {
            ...task.metadata,
            ...updates.metadata,
          } as CodeTaskMetadata;
        }
      },
    );

    vi.spyOn(runtime, "deleteTask").mockImplementation(async (id: UUID) => {
      tasks.delete(id);
    });

    service = (await CodeTaskService.start(runtime)) as CodeTaskService;
    serviceRef = service;
  });

  afterEach(async () => {
    delete process.env.ELIZA_CODE_ACTIVE_SUB_AGENT;
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  test("CREATE_TASK validate allows file-extension requests but avoids small snippet requests", async () => {
    const valid1 = await createTaskAction.validate(
      runtime,
      createMemory("build me tetris in tetris.html", roomId),
    );
    expect(valid1).toBe(true);

    const valid2 = await createTaskAction.validate(
      runtime,
      createMemory("add a button to style.css", roomId),
    );
    expect(valid2).toBe(true);

    const valid3 = await createTaskAction.validate(
      runtime,
      createMemory("write a quicksort function", roomId),
    );
    expect(valid3).toBe(false);
  });

  test("CREATE_TASK handler creates a task with initial steps from options", async () => {
    const msg = createMemory("Build a Tetris game with high scores", roomId);

    const responses: Memory[] = [];
    await createTaskAction.handler(
      runtime,
      msg,
      undefined,
      { title: "Build Tetris", steps: ["step 1", "step 2"] },
      (result) => {
        responses.push(result);
        return Promise.resolve([]);
      },
    );

    const allTasks = await service.getTasks();
    expect(allTasks.length).toBeGreaterThan(0);
    const task = allTasks[0];
    expect(task.name).toBe("Build Tetris");
    expect(task.metadata.steps).toHaveLength(2);
    expect(task.metadata.steps[0]).toMatchObject({
      description: "step 1",
      status: "pending",
    });
    expect(task.metadata.steps[1]).toMatchObject({
      description: "step 2",
      status: "pending",
    });
  });

  test("PAUSE_TASK pauses a running task", async () => {
    const task = await service.createCodeTask("Runner", "desc", roomId);
    service.setCurrentTask(task.id ?? null);
    await service.updateTaskStatus(task.id ?? "", "running");

    const msg = createMemory("pause my task", roomId);
    await pauseTaskAction.handler(runtime, msg, undefined, {}, () =>
      Promise.resolve([]),
    );

    const updated = await service.getTask(task.id ?? "");
    expect(updated?.metadata.status).toBe("paused");
  });

  test("RESUME_TASK resumes a paused task (without running execution)", async () => {
    const task = await service.createCodeTask("Runner", "desc", roomId);
    service.setCurrentTask(task.id ?? null);
    await service.updateTaskStatus(task.id ?? "", "paused");

    const msg = createMemory("resume my task", roomId);
    await resumeTaskAction.handler(runtime, msg, undefined, {}, () =>
      Promise.resolve([]),
    );

    const updated = await service.getTask(task.id ?? "");
    expect(updated?.metadata.status).toBe("running");
  });

  test("CANCEL_TASK cancels a task", async () => {
    const task = await service.createCodeTask("CancelMe", "desc", roomId);
    service.setCurrentTask(task.id ?? null);

    const msg = createMemory("cancel my task", roomId);
    await cancelTaskAction.handler(runtime, msg, undefined, {}, () =>
      Promise.resolve([]),
    );

    const updated = await service.getTask(task.id ?? "");
    expect(updated?.metadata.status).toBe("cancelled");
  });

  test("LIST_TASKS returns summaries", async () => {
    await service.createCodeTask("Task A", "desc A", roomId);
    await service.createCodeTask("Task B", "desc B", roomId);

    const msg = createMemory("show all tasks", roomId);
    const responses: Memory[] = [];
    await listTasksAction.handler(runtime, msg, undefined, {}, (m) => {
      responses.push(m);
      return Promise.resolve([]);
    });

    expect(responses[0].content.text).toContain("Task A");
    expect(responses[0].content.text).toContain("Task B");
  });

  test("SEARCH_TASKS finds tasks by query", async () => {
    await service.createCodeTask(
      "Build Tetris",
      "Tetris game with high scores",
      roomId,
    );
    await service.createCodeTask("Fix Bug", "Address login bug", roomId);

    const msg = createMemory("search tasks for tetris", roomId);
    const responses: Memory[] = [];
    await searchTasksAction.handler(
      runtime,
      msg,
      undefined,
      { query: "tetris" },
      (m) => {
        responses.push(m);
        return Promise.resolve([]);
      },
    );

    expect(responses[0].content.text).toContain("Tetris");
    expect(responses[0].content.text).not.toContain("Fix Bug");
  });

  test("SWITCH_TASK changes current task", async () => {
    const task1 = await service.createCodeTask("Task One", "desc", roomId);
    const task2 = await service.createCodeTask("Task Two", "desc", roomId);
    service.setCurrentTask(task1.id ?? null);

    const msg = createMemory("switch to task two", roomId);
    await switchTaskAction.handler(
      runtime,
      msg,
      undefined,
      { taskId: task2.id },
      () => Promise.resolve([]),
    );

    expect(service.getCurrentTaskId()).toBe(task2.id);
  });
});
