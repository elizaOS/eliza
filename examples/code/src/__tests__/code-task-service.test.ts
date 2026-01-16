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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeTask, CodeTaskMetadata } from "../types.js";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils.js";

describe("CodeTaskService", () => {
  let service: CodeTaskService;
  let runtime: IAgentRuntime;

  // In-memory task store for testing
  let tasks: Map<string, CodeTask>;
  let rooms: Map<string, Room>;
  let taskCounter: number;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    tasks = new Map();
    rooms = new Map();
    taskCounter = 0;

    // Default room (used by tests that pass a roomId)
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

    service = (await CodeTaskService.start(runtime)) as CodeTaskService;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  describe("createCodeTask", () => {
    it("should create a task with metadata", async () => {
      const task = await service.createCodeTask(
        "Test Task",
        "A test task description",
      );

      expect(task.name).toBe("Test Task");
      expect(task.description).toBe("A test task description");
      expect(task.metadata.status).toBe("pending");
      expect(task.metadata.progress).toBe(0);
      expect(task.metadata.output).toEqual([]);
      expect(task.metadata.userStatus).toBe("open");
      expect(task.metadata.filesCreated).toEqual([]);
      expect(task.metadata.filesModified).toEqual([]);
      expect(task.tags).toContain("code");
      // World ID must be set for SQL adapter compatibility (falls back to agentId when no roomId)
      expect(task.worldId).toBe(runtime.agentId);
    });

    it("should resolve worldId from room when roomId is provided", async () => {
      const roomId = stringToUuid("test-room");
      const expectedWorldId = stringToUuid("test-world");

      const task = await service.createCodeTask(
        "Room Task",
        "Description",
        roomId,
      );

      expect(task.roomId).toBe(roomId);
      expect(task.worldId).toBe(expectedWorldId);
    });

    it("should auto-select first created task", async () => {
      expect(service.getCurrentTaskId()).toBeNull();

      const task = await service.createCodeTask("First Task", "Description");

      expect(service.getCurrentTaskId()).toBe(task.id);
    });

    it("should emit task:created event", async () => {
      const events: string[] = [];
      service.on("task:created", () => events.push("created"));

      await service.createCodeTask("Event Task", "Description");

      expect(events).toContain("created");
    });
  });

  describe("getTask", () => {
    it("should return task by id", async () => {
      const created = await service.createCodeTask("Find Me", "Description");
      const found = await service.getTask(created.id ?? "");

      expect(found).not.toBeNull();
      expect(found?.name).toBe("Find Me");
    });

    it("should return null for unknown id", async () => {
      const found = await service.getTask("unknown-id");

      expect(found).toBeNull();
    });
  });

  describe("searchTasks", () => {
    beforeEach(async () => {
      await service.createCodeTask(
        "Authentication API",
        "User login and logout",
      );
      await service.createCodeTask("File Upload", "Handle file uploads");
      await service.createCodeTask("Auth Middleware", "Request authentication");
    });

    it("should find tasks by name", async () => {
      const results = await service.searchTasks("auth");

      expect(results.length).toBe(2);
      expect(results.map((t) => t.name)).toContain("Authentication API");
      expect(results.map((t) => t.name)).toContain("Auth Middleware");
    });

    it("should find tasks by description", async () => {
      const results = await service.searchTasks("upload");

      expect(results.length).toBe(1);
      expect(results[0].name).toBe("File Upload");
    });

    it("should return empty for no matches", async () => {
      const results = await service.searchTasks("nonexistent");

      expect(results).toHaveLength(0);
    });
  });

  describe("updateTaskStatus", () => {
    it("should update task status", async () => {
      const task = await service.createCodeTask("Status Task", "Description");
      await service.updateTaskStatus(task.id ?? "", "running");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.status).toBe("running");
      expect(updated?.metadata.startedAt).toBeDefined();
    });

    it("should set completedAt when completed", async () => {
      const task = await service.createCodeTask("Complete Task", "Description");
      await service.updateTaskStatus(task.id ?? "", "completed");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.completedAt).toBeDefined();
    });

    it("should set completedAt when cancelled", async () => {
      const task = await service.createCodeTask(
        "Cancelled Task",
        "Description",
      );
      await service.updateTaskStatus(task.id ?? "", "cancelled");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.completedAt).toBeDefined();
    });
  });

  describe("updateTaskProgress", () => {
    it("should update progress", async () => {
      const task = await service.createCodeTask("Progress Task", "Description");
      await service.updateTaskProgress(task.id ?? "", 50);

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.progress).toBe(50);
    });

    it("should clamp progress to 0-100", async () => {
      const task = await service.createCodeTask("Clamp Task", "Description");

      await service.updateTaskProgress(task.id ?? "", 150);
      let updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.progress).toBe(100);

      await service.updateTaskProgress(task.id ?? "", -10);
      updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.progress).toBe(0);
    });
  });

  describe("appendOutput", () => {
    it("should append output lines", async () => {
      const task = await service.createCodeTask("Output Task", "Description");
      await service.appendOutput(task.id ?? "", "Line 1\nLine 2");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.output).toContain("Line 1");
      expect(updated?.metadata.output).toContain("Line 2");
    });

    it("should filter empty lines", async () => {
      const task = await service.createCodeTask("Filter Task", "Description");
      await service.appendOutput(task.id ?? "", "Line 1\n\n\nLine 2");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.output).toEqual(["Line 1", "Line 2"]);
    });
  });

  describe("setCurrentTask", () => {
    it("should update current task id", async () => {
      await service.createCodeTask("Task 1", "Description");
      const task2 = await service.createCodeTask("Task 2", "Description");

      service.setCurrentTask(task2.id ?? null);

      expect(service.getCurrentTaskId()).toBe(task2.id);
    });

    it("should allow setting to null", () => {
      service.setCurrentTask(null);

      expect(service.getCurrentTaskId()).toBeNull();
    });
  });

  describe("deleteTask", () => {
    it("should delete task", async () => {
      const task = await service.createCodeTask("Delete Me", "Description");
      await service.deleteTask(task.id ?? "");

      const found = await service.getTask(task.id ?? "");
      expect(found).toBeNull();
    });

    it("should clear current task if deleted", async () => {
      const task = await service.createCodeTask("Current Task", "Description");
      service.setCurrentTask(task.id ?? null);

      await service.deleteTask(task.id ?? "");

      expect(service.getCurrentTaskId()).toBeNull();
    });
  });

  describe("setUserStatus", () => {
    it("should update userStatus", async () => {
      const task = await service.createCodeTask(
        "User Status Task",
        "Description",
      );
      await service.setUserStatus(task.id ?? "", "done");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.userStatus).toBe("done");
    });
  });

  describe("cancelTask", () => {
    it("should mark task as cancelled", async () => {
      const task = await service.createCodeTask("Cancel Me", "Description");
      await service.cancelTask(task.id ?? "");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.status).toBe("cancelled");
      expect(service.isTaskCancelled(task.id ?? "")).toBe(true);
    });
  });

  describe("getTaskContext", () => {
    it("should return context string", async () => {
      const task = await service.createCodeTask(
        "Context Task",
        "A task for testing context",
      );
      await service.appendOutput(task.id ?? "", "Some output");

      const context = await service.getTaskContext();

      expect(context).toContain("Context Task");
      expect(context).toContain("pending");
      expect(context).toContain("Some output");
      expect(context).toContain("Task Output (history)");
    });

    it("should return empty message when no tasks", async () => {
      const context = await service.getTaskContext();

      expect(context).toBe("No tasks have been created yet.");
    });

    it("should include steps in the context", async () => {
      const task = await service.createCodeTask("Step Task", "Has steps");
      const id = task.id ?? "";
      await service.addStep(id, "First step");

      const context = await service.getTaskContext();
      expect(context).toContain("Plan / Steps");
      expect(context).toContain("First step");
    });
  });
});
