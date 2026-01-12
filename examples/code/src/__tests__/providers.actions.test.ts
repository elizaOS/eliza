import {
  ChannelType,
  type IAgentRuntime,
  type Memory,
  type Room,
  type State,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  pauseTaskAction,
  resumeTaskAction,
} from "../plugin/actions/task-management.js";
import { actionsProvider } from "../plugin/providers/actions.js";
import { CodeTaskService } from "../plugin/services/code-task.js";
import type { CodeTask, CodeTaskMetadata } from "../types.js";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils.js";

function createMemory(text: string, roomId?: UUID): Memory {
  return {
    content: { text },
    roomId,
  } as Memory;
}

describe("ACTIONS provider includes task control actions", () => {
  let runtime: IAgentRuntime;
  let service: CodeTaskService;
  let tasks: Map<string, CodeTask>;
  let rooms: Map<string, Room>;
  let taskCounter: number;
  let serviceRef: CodeTaskService | null;
  const roomId = stringToUuid("test-room");
  const worldId = stringToUuid("test-world");

  beforeEach(async () => {
    runtime = await createTestRuntime();
    tasks = new Map();
    rooms = new Map();
    taskCounter = 0;
    serviceRef = null;

    // Set up default room
    rooms.set(roomId, {
      id: roomId,
      source: "test",
      type: ChannelType.DM,
      worldId,
      name: "Test Room",
    });

    // Spy on runtime methods
    vi.spyOn(runtime, "getRoom").mockImplementation(async (id: UUID) => rooms.get(id) ?? null);

    vi.spyOn(runtime, "getService").mockImplementation((type: string) => {
      if (type === "CODE_TASK") return serviceRef;
      return null;
    });

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

    vi.spyOn(runtime, "getTask").mockImplementation(async (id: UUID) => tasks.get(id) ?? null);

    vi.spyOn(runtime, "getTasks").mockImplementation(async ({ tags }: { tags?: string[] }) => {
      const allTasks = Array.from(tasks.values());
      if (!tags || tags.length === 0) return allTasks;
      return allTasks.filter((t) => tags.some((tag) => t.tags?.includes(tag)));
    });

    vi.spyOn(runtime, "updateTask").mockImplementation(async (id: UUID, updates: Partial<Task>) => {
      const task = tasks.get(id);
      if (!task) return;
      if (updates.metadata)
        task.metadata = { ...task.metadata, ...updates.metadata };
    });

    vi.spyOn(runtime, "deleteTask").mockImplementation(async (id: UUID) => {
      tasks.delete(id);
    });

    vi.spyOn(runtime, "useModel").mockImplementation(async () => {
      throw new Error("useModel should not be called in this test");
    });

    // Set up actions on runtime
    runtime.actions = [pauseTaskAction, resumeTaskAction];

    service = (await CodeTaskService.start(runtime)) as CodeTaskService;
    serviceRef = service;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  test("stop task -> PAUSE_TASK appears in possible actions", async () => {
    const msg = createMemory("stop task runner", roomId);
    const res = await actionsProvider.get(runtime, msg, {} as State);
    expect(res.data.actionsData.map((a) => a.name)).toContain("PAUSE_TASK");
  });

  test("restart task -> RESUME_TASK appears in possible actions", async () => {
    process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION = "1";

    await service.createCodeTask("Runner", "desc", roomId);

    const msg = createMemory("restart task runner", roomId);
    const res = await actionsProvider.get(runtime, msg, {} as State);
    expect(res.data.actionsData.map((a) => a.name)).toContain("RESUME_TASK");
    delete process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION;
  });
});
