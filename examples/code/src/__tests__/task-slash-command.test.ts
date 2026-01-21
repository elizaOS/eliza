import {
  ChannelType,
  type IAgentRuntime,
  type Room,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core";
import {
  type AgentProvider,
  AgentOrchestratorService as CodeTaskService,
  configureAgentOrchestratorPlugin,
  type OrchestratedTask,
  type ProviderTaskExecutionContext,
  type TaskResult,
} from "@elizaos/plugin-agent-orchestrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { handleTaskSlashCommand } from "../lib/task-slash-command.js";
import type {
  CodeTask,
  CodeTaskMetadata,
  TaskPaneVisibility,
} from "../types.js";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils.js";

describe("TUI /task slash commands", () => {
  let runtime: IAgentRuntime;
  let service: CodeTaskService;
  let messages: string[];
  let started: string[];
  let taskPaneVisibility: TaskPaneVisibility;

  // In-memory stores for testing
  let tasks: Map<string, CodeTask>;
  let rooms: Map<string, Room>;
  let taskCounter: number;
  let serviceRef: CodeTaskService | null;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    tasks = new Map();
    rooms = new Map();
    taskCounter = 0;
    serviceRef = null;

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

    // Spy on runtime methods with test-specific implementations
    vi.spyOn(runtime, "getRoom").mockImplementation(
      async (id: UUID) => rooms.get(id) ?? null,
    );

    vi.spyOn(runtime, "getService").mockImplementation((type: string) => {
      if (type === "CODE_TASK") return serviceRef;
      return null;
    });

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
          task.metadata = { ...task.metadata, ...updates.metadata };
        }
      },
    );

    vi.spyOn(runtime, "deleteTask").mockImplementation(async (id: UUID) => {
      tasks.delete(id);
    });

    vi.spyOn(runtime, "useModel").mockImplementation(async () => {
      throw new Error("useModel should not be called in this test");
    });

    service = (await CodeTaskService.start(runtime)) as CodeTaskService;
    serviceRef = service;

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

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
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
    expect((await service.getTask(task.id ?? ""))?.metadata.status).toBe(
      "paused",
    );
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
    expect((await service.getTask(task.id ?? ""))?.metadata.status).toBe(
      "running",
    );
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

  test("/task agent sets sub-agent type on the current task", async () => {
    const task = await service.createCodeTask("Runner", "desc");
    service.setCurrentTask(task.id ?? null);

    const ok = await handleTaskSlashCommand("agent opencode", {
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
    expect((await service.getTask(task.id ?? ""))?.metadata.subAgentType).toBe(
      "opencode",
    );
    expect(messages.join("\n")).toContain("Set sub-agent");
  });
});
