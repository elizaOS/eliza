import { describe, test, expect, beforeEach } from "bun:test";
import { ChannelType, stringToUuid, type IAgentRuntime, type Memory, type Room, type State, type Task, type UUID } from "@elizaos/core";
import { actionsProvider } from "../plugin/providers/actions.js";
import { CodeTaskService } from "../plugin/services/code-task.js";
import type { CodeTask, CodeTaskMetadata } from "../types.js";
import { pauseTaskAction, resumeTaskAction } from "../plugin/actions/task-management.js";

function createMemory(text: string, roomId?: UUID): Memory {
  return {
    content: { text },
    roomId,
  } as Memory;
}

function createMockRuntimeWithService(actions: IAgentRuntime["actions"]): {
  runtime: IAgentRuntime;
  setService: (service: CodeTaskService) => void;
  roomId: UUID;
} {
  const tasks = new Map<string, CodeTask>();
  const rooms = new Map<string, Room>();
  let taskCounter = 0;
  const agentId = stringToUuid("test-agent");

  const roomId = stringToUuid("test-room");
  const worldId = stringToUuid("test-world");
  rooms.set(roomId, {
    id: roomId,
    source: "test",
    type: ChannelType.DM,
    worldId,
    name: "Test Room",
  });

  let serviceRef: CodeTaskService | null = null;

  const runtime: Partial<IAgentRuntime> = {
    agentId,
    actions,

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
      if (updates.metadata) task.metadata = { ...task.metadata, ...updates.metadata };
    },

    deleteTask: async (id: UUID) => {
      tasks.delete(id);
    },

    useModel: async () => {
      throw new Error("useModel should not be called in this test");
    },
  };

  return {
    runtime: runtime as IAgentRuntime,
    setService: (svc) => {
      serviceRef = svc;
    },
    roomId,
  };
}

describe("ACTIONS provider includes task control actions", () => {
  test("stop task -> PAUSE_TASK appears in possible actions", async () => {
    const { runtime, setService, roomId } = createMockRuntimeWithService([pauseTaskAction, resumeTaskAction]);
    const service = (await CodeTaskService.start(runtime)) as CodeTaskService;
    setService(service);

    const msg = createMemory("stop task runner", roomId);
    const res = await actionsProvider.get(runtime, msg, {} as State);
    expect(res.data.actionsData.map((a) => a.name)).toContain("PAUSE_TASK");
  });

  test("restart task -> RESUME_TASK appears in possible actions", async () => {
    process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION = "1";
    const { runtime, setService, roomId } = createMockRuntimeWithService([pauseTaskAction, resumeTaskAction]);
    const service = (await CodeTaskService.start(runtime)) as CodeTaskService;
    setService(service);

    await service.createCodeTask("Runner", "desc", roomId);

    const msg = createMemory("restart task runner", roomId);
    const res = await actionsProvider.get(runtime, msg, {} as State);
    expect(res.data.actionsData.map((a) => a.name)).toContain("RESUME_TASK");
    delete process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION;
  });
});


