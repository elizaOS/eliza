import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ChannelType, stringToUuid, type IAgentRuntime, type Room, type Task, type UUID } from "@elizaos/core";
import { CodeTaskService } from "../plugin/services/code-task.js";
import type { CodeTask, CodeTaskMetadata, TaskPaneVisibility } from "../types.js";
import { handleTaskSlashCommand } from "../lib/task-slash-command.js";

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
      if (typeof updates.description === "string") task.description = updates.description;
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

describe("TUI /task slash commands", () => {
  let runtime: IAgentRuntime;
  let service: CodeTaskService;
  let messages: string[];
  let started: string[];
  let taskPaneVisibility: TaskPaneVisibility;

  beforeEach(async () => {
    process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION = "1";

    const { runtime: r, setService } = createMockRuntimeWithService();
    runtime = r;
    service = (await CodeTaskService.start(runtime)) as CodeTaskService;
    setService(service);

    messages = [];
    started = [];
    taskPaneVisibility = "auto";

    // Spy on startTaskExecution so we can assert /task start/resume trigger it.
    const original = service.startTaskExecution.bind(service);
    service.startTaskExecution = (taskId: string) => {
      started.push(taskId);
      return original(taskId);
    };
  });

  afterEach(() => {
    delete process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION;
  });

  test("/task pause pauses the current task", async () => {
    const task = await service.createCodeTask("Runner", "desc");
    service.setCurrentTask(task.id ?? null);
    await service.updateTaskStatus(task.id ?? "", "running");

    const ok = await handleTaskSlashCommand("pause", {
      service,
      currentRoomId: "room",
      addMessage: (_roomId, _role, content) => messages.push(content),
      setCurrentTaskId: () => {},
      setTaskPaneVisibility: (v) => {
        taskPaneVisibility = v;
      },
      taskPaneVisibility,
      showTaskPane: true,
    });
    expect(ok).toBe(true);
    expect((await service.getTask(task.id ?? ""))?.metadata.status).toBe("paused");
    expect(messages.join("\n")).toContain("Task paused");
  });

  test("/task resume resumes the current task and triggers execution", async () => {
    const task = await service.createCodeTask("Runner", "desc");
    service.setCurrentTask(task.id ?? null);
    await service.updateTaskStatus(task.id ?? "", "paused");

    const ok = await handleTaskSlashCommand("resume", {
      service,
      currentRoomId: "room",
      addMessage: (_roomId, _role, content) => messages.push(content),
      setCurrentTaskId: () => {},
      setTaskPaneVisibility: (v) => {
        taskPaneVisibility = v;
      },
      taskPaneVisibility,
      showTaskPane: true,
    });
    expect(ok).toBe(true);
    expect((await service.getTask(task.id ?? ""))?.metadata.status).toBe("running");
    expect(started).toContain(task.id ?? "");
  });

  test("/task start triggers execution for the current task", async () => {
    const task = await service.createCodeTask("Runner", "desc");
    service.setCurrentTask(task.id ?? null);

    const ok = await handleTaskSlashCommand("start", {
      service,
      currentRoomId: "room",
      addMessage: (_roomId, _role, content) => messages.push(content),
      setCurrentTaskId: () => {},
      setTaskPaneVisibility: (v) => {
        taskPaneVisibility = v;
      },
      taskPaneVisibility,
      showTaskPane: true,
    });
    expect(ok).toBe(true);
    expect(started).toContain(task.id ?? "");
    expect(messages.join("\n")).toContain("Restarting:");
  });
});



