import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type Room,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTaskAction } from "../plugin/actions/create-task.js";
import {
  cancelTaskAction,
  listTasksAction,
  pauseTaskAction,
  resumeTaskAction,
  searchTasksAction,
  switchTaskAction,
} from "../plugin/actions/task-management.js";
import { CodeTaskService } from "../plugin/services/code-task.js";
import type { CodeTask, CodeTaskMetadata } from "../types.js";

function createMemory(text: string, roomId?: UUID): Memory {
  return {
    content: { text },
    roomId,
  } as Memory;
}

function createMockRuntimeWithService(): {
  runtime: IAgentRuntime;
  setService: (service: CodeTaskService) => void;
} {
  const tasks = new Map<string, CodeTask>();
  const rooms = new Map<string, Room>();
  let taskCounter = 0;
  const agentId = stringToUuid("test-agent");

  // Default room (used when tests pass a roomId)
  const defaultRoomId = stringToUuid("test-room");
  const defaultWorldId = stringToUuid("test-world");
  rooms.set(defaultRoomId, {
    id: defaultRoomId,
    source: "test",
    type: ChannelType.DM,
    worldId: defaultWorldId,
    name: "Test Room",
  });

  let serviceRef: CodeTaskService | null = null;

  const runtime: Partial<IAgentRuntime> = {
    agentId,

    getRoom: async (id: UUID) => rooms.get(id) ?? null,

    getService: (type: string) => {
      if (type === "CODE_TASK") return serviceRef;
      return null;
    },

    createTask: async (task: Task) => {
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
    },

    getTask: async (id: UUID) => tasks.get(id) ?? null,

    getTasks: async ({ tags }: { tags?: string[] }) => {
      const allTasks = Array.from(tasks.values());
      if (!tags || tags.length === 0) return allTasks;
      return allTasks.filter((t) => tags.some((tag) => t.tags?.includes(tag)));
    },

    updateTask: async (id: UUID, updates: Partial<Task>) => {
      const task = tasks.get(id);
      if (!task) return;

      if (typeof updates.name === "string") task.name = updates.name;
      if (typeof updates.description === "string")
        task.description = updates.description;
      if (Array.isArray(updates.tags)) task.tags = updates.tags;
      if (updates.roomId) task.roomId = updates.roomId;
      if (updates.worldId) task.worldId = updates.worldId;
      if (updates.metadata) {
        task.metadata = { ...task.metadata, ...updates.metadata };
      }
    },

    deleteTask: async (id: UUID) => {
      tasks.delete(id);
    },

    // In these tests we provide explicit steps so CREATE_TASK shouldn't need planning.
    useModel: async () => {
      throw new Error("useModel should not be called in this test");
    },
  };

  return {
    runtime: runtime as IAgentRuntime,
    setService: (svc) => {
      serviceRef = svc;
    },
  };
}

describe("plugin actions: task management", () => {
  let runtime: IAgentRuntime;
  let service: CodeTaskService;
  let roomId: UUID;

  beforeEach(async () => {
    process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION = "1";

    const envRoomId = stringToUuid("test-room");
    roomId = envRoomId;

    const { runtime: r, setService } = createMockRuntimeWithService();
    runtime = r;

    service = (await CodeTaskService.start(runtime)) as CodeTaskService;
    setService(service);
  });

  afterEach(() => {
    delete process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION;
  });

  test("CREATE_TASK validate avoids file-extension requests and small snippet requests", async () => {
    const valid1 = await createTaskAction.validate(
      runtime,
      createMemory("build me tetris in tetris.html", roomId),
    );
    expect(valid1).toBe(false);

    const valid2 = await createTaskAction.validate(
      runtime,
      createMemory("implement quicksort algorithm", roomId),
    );
    expect(valid2).toBe(false);

    const valid3 = await createTaskAction.validate(
      runtime,
      createMemory("create a task to implement oauth login", roomId),
    );
    expect(valid3).toBe(true);
  });

  test("CREATE_TASK handler creates a task with steps and does not start execution when disabled", async () => {
    const msg = createMemory(
      [
        "create task: OAuth login",
        "description: add oauth to the app",
        "steps:",
        "1. Add routes",
        "2. Add tests",
      ].join("\n"),
      roomId,
    );

    const result = await createTaskAction.handler(
      runtime,
      msg,
      undefined,
      undefined,
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("Created task");
    expect(result.text.toLowerCase()).toContain("execution disabled");

    const tasks = await service.getTasks();
    expect(tasks).toHaveLength(1);

    const task = tasks[0];
    expect(task.metadata.status).toBe("pending");
    expect(task.metadata.steps).toHaveLength(2);
    expect(task.metadata.output.join("\n")).toContain("Plan:");
  });

  test("LIST_TASKS shows recent tasks grouped by status and marks current", async () => {
    const t1 = await service.createCodeTask("Auth", "Auth task", roomId);
    const t2 = await service.createCodeTask(
      "Refactor",
      "Refactor task",
      roomId,
    );
    const t3 = await service.createCodeTask("Done", "Done task", roomId);

    await service.updateTaskStatus(t1.id ?? "", "running");
    await service.updateTaskStatus(t3.id ?? "", "completed");
    service.setCurrentTask(t2.id ?? null);

    const result = await listTasksAction.handler(
      runtime,
      createMemory("show me my tasks", roomId),
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("Tasks:");
    expect(result.text).toContain("Running");
    expect(result.text).toContain("Pending");
    expect(result.text).toContain("Completed");
    expect(result.text).toContain("(current)");
  });

  test("SWITCH_TASK selects the best match and updates current task", async () => {
    const t1 = await service.createCodeTask(
      "Authentication API",
      "auth",
      roomId,
    );
    await service.createCodeTask("File Upload", "upload", roomId);

    const result = await switchTaskAction.handler(
      runtime,
      createMemory("switch to task auth", roomId),
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("Switched to task");
    expect(service.getCurrentTaskId()).toBe(t1.id ?? null);
  });

  test("SEARCH_TASKS returns matching tasks", async () => {
    await service.createCodeTask("Authentication API", "auth", roomId);
    await service.createCodeTask("File Upload", "upload", roomId);

    const result = await searchTasksAction.handler(
      runtime,
      createMemory("find tasks about auth", roomId),
    );
    expect(result.success).toBe(true);
    expect(result.text).toContain("Authentication API");
  });

  test("PAUSE_TASK/RESUME_TASK updates status of current task", async () => {
    const task = await service.createCodeTask("Runner", "desc", roomId);
    service.setCurrentTask(task.id ?? null);
    await service.updateTaskStatus(task.id ?? "", "running");

    const paused = await pauseTaskAction.handler(
      runtime,
      createMemory("pause the task", roomId),
    );
    expect(paused.success).toBe(true);
    expect((await service.getTask(task.id ?? ""))?.metadata.status).toBe(
      "paused",
    );

    const resumed = await resumeTaskAction.handler(
      runtime,
      createMemory("resume the task", roomId),
    );
    expect(resumed.success).toBe(true);
    expect((await service.getTask(task.id ?? ""))?.metadata.status).toBe(
      "running",
    );
  });

  test("PAUSE_TASK validate matches stop/halt language", async () => {
    const v1 = await pauseTaskAction.validate(
      runtime,
      createMemory("stop task runner", roomId),
    );
    expect(v1).toBe(true);
    const v2 = await pauseTaskAction.validate(
      runtime,
      createMemory("halt the task", roomId),
    );
    expect(v2).toBe(true);
  });

  test("RESUME_TASK validate matches start language when task exists", async () => {
    await service.createCodeTask("Runner", "desc", roomId);
    const v1 = await resumeTaskAction.validate(
      runtime,
      createMemory("start task runner", roomId),
    );
    expect(v1).toBe(true);
    const v2 = await resumeTaskAction.validate(
      runtime,
      createMemory("run task runner", roomId),
    );
    expect(v2).toBe(true);
  });

  test("CANCEL_TASK cancels a task by name", async () => {
    const task = await service.createCodeTask("Cancel Me", "desc", roomId);
    const result = await cancelTaskAction.handler(
      runtime,
      createMemory("cancel task cancel me", roomId),
    );

    expect(result.success).toBe(true);
    const updated = await service.getTask(task.id ?? "");
    expect(updated?.metadata.status).toBe("cancelled");
  });
});
