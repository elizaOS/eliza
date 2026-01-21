/**
 * Comprehensive integration tests for the Agent Orchestrator.
 *
 * Tests verify that the orchestrator correctly:
 * 1. Creates tasks and routes them to the correct sub-agent
 * 2. Handles task lifecycle (pause, resume, cancel, complete)
 * 3. Tracks progress and output
 * 4. Lists and searches tasks
 * 5. Marks tasks as finished
 *
 * Each of the 4 primary agent types is tested:
 * - eliza (Eliza with plugin-code) - DEFAULT
 * - claude-code (Claude Agent SDK)
 * - codex (OpenAI Codex SDK)
 * - sweagent (SWE-agent)
 */

import {
  ChannelType,
  type IAgentRuntime,
  type Room,
  stringToUuid,
  type Task,
  type UUID,
} from "@elizaos/core";
import {
  AgentOrchestratorService,
  type AgentProvider,
  configureAgentOrchestratorPlugin,
  type OrchestratedTask,
  type ProviderTaskExecutionContext,
  type TaskResult,
} from "@elizaos/plugin-agent-orchestrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeTask, CodeTaskMetadata } from "../types.js";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils.js";

// Track which provider was called for each task
const executionLog: Array<{
  providerId: string;
  taskName: string;
  completed: boolean;
}> = [];

// Create mock providers that track execution
function createMockProvider(
  id: string,
  label: string,
  opts: { shouldSucceed?: boolean; delay?: number } = {},
): AgentProvider {
  const { shouldSucceed = true, delay = 0 } = opts;
  return {
    id,
    label,
    executeTask: async (
      task: OrchestratedTask,
      ctx: ProviderTaskExecutionContext,
    ): Promise<TaskResult> => {
      executionLog.push({
        providerId: id,
        taskName: task.name,
        completed: false,
      });

      await ctx.appendOutput(`[${label}] Starting task: ${task.name}`);
      await ctx.updateProgress(10);

      // Simulate work with optional delay
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // Check for cancellation/pause
      if (ctx.isCancelled()) {
        return {
          success: false,
          summary: "Task was cancelled",
          filesCreated: [],
          filesModified: [],
          error: "Cancelled",
        };
      }

      await ctx.appendOutput(`[${label}] Task completed`);
      await ctx.updateProgress(100);

      const entry = executionLog.find(
        (e) => e.providerId === id && e.taskName === task.name && !e.completed,
      );
      if (entry) entry.completed = true;

      if (!shouldSucceed) {
        return {
          success: false,
          summary: `${label} failed intentionally`,
          filesCreated: [],
          filesModified: [],
          error: "Intentional failure",
        };
      }

      return {
        success: true,
        summary: `${label} completed: ${task.name}`,
        filesCreated: ["new-file.ts"],
        filesModified: ["existing-file.ts"],
      };
    },
  };
}

describe("Agent Orchestrator Integration", () => {
  let service: AgentOrchestratorService;
  let runtime: IAgentRuntime;
  let tasks: Map<string, CodeTask>;
  let rooms: Map<string, Room>;
  let taskCounter: number;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    tasks = new Map();
    rooms = new Map();
    taskCounter = 0;
    executionLog.length = 0;

    // Setup default room
    const defaultRoomId = stringToUuid("test-room");
    const defaultWorldId = stringToUuid("test-world");
    rooms.set(defaultRoomId, {
      id: defaultRoomId,
      source: "test",
      type: ChannelType.DM,
      worldId: defaultWorldId,
      name: "Test Room",
    });

    // Mock runtime methods
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

    // Configure orchestrator with all 4 required providers
    configureAgentOrchestratorPlugin({
      providers: [
        createMockProvider("eliza", "Eliza (plugin-code)"),
        createMockProvider("claude-code", "Claude Code"),
        createMockProvider("codex", "Codex"),
        createMockProvider("sweagent", "SWE-agent"),
      ],
      defaultProviderId: "eliza",
      getWorkingDirectory: () => process.cwd(),
      activeProviderEnvVar: "ELIZA_CODE_ACTIVE_SUB_AGENT",
    });

    service = (await AgentOrchestratorService.start(
      runtime,
    )) as AgentOrchestratorService;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  // ============================================================================
  // Task Creation & Provider Routing
  // ============================================================================

  describe("Task Creation and Provider Routing", () => {
    it("should use eliza as the default provider", async () => {
      const task = await service.createTask("Test Task", "Test description");

      expect(task.metadata.providerId).toBe("eliza");
      expect(task.metadata.providerLabel).toBe("Eliza (plugin-code)");
    });

    it("should route to claude-code when specified", async () => {
      const task = await service.createTask(
        "Claude Task",
        "Use Claude Code",
        undefined,
        "claude-code",
      );

      expect(task.metadata.providerId).toBe("claude-code");
      expect(task.metadata.providerLabel).toBe("Claude Code");
    });

    it("should route to codex when specified", async () => {
      const task = await service.createTask(
        "Codex Task",
        "Use Codex",
        undefined,
        "codex",
      );

      expect(task.metadata.providerId).toBe("codex");
      expect(task.metadata.providerLabel).toBe("Codex");
    });

    it("should route to sweagent when specified", async () => {
      const task = await service.createTask(
        "SWE Task",
        "Use SWE-agent",
        undefined,
        "sweagent",
      );

      expect(task.metadata.providerId).toBe("sweagent");
      expect(task.metadata.providerLabel).toBe("SWE-agent");
    });

    it("should throw error for unknown provider", async () => {
      await expect(
        service.createTask(
          "Bad Task",
          "Unknown provider",
          undefined,
          "unknown-provider",
        ),
      ).rejects.toThrow(/Unknown provider/);
    });
  });

  // ============================================================================
  // Task Execution
  // ============================================================================

  describe("Task Execution", () => {
    it("should execute task with eliza provider", async () => {
      const task = await service.createTask(
        "Eliza Execution",
        "Run with eliza",
      );
      await service.startTaskExecution(task.id ?? "");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.status).toBe("completed");
      expect(updated?.metadata.progress).toBe(100);
      expect(updated?.metadata.result?.success).toBe(true);
      expect(
        executionLog.some((e) => e.providerId === "eliza" && e.completed),
      ).toBe(true);
    });

    it("should execute task with claude-code provider", async () => {
      const task = await service.createTask(
        "Claude Execution",
        "Run with Claude",
        undefined,
        "claude-code",
      );
      await service.startTaskExecution(task.id ?? "");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.status).toBe("completed");
      expect(
        executionLog.some((e) => e.providerId === "claude-code" && e.completed),
      ).toBe(true);
    });

    it("should execute task with codex provider", async () => {
      const task = await service.createTask(
        "Codex Execution",
        "Run with Codex",
        undefined,
        "codex",
      );
      await service.startTaskExecution(task.id ?? "");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.status).toBe("completed");
      expect(
        executionLog.some((e) => e.providerId === "codex" && e.completed),
      ).toBe(true);
    });

    it("should execute task with sweagent provider", async () => {
      const task = await service.createTask(
        "SWE Execution",
        "Run with SWE-agent",
        undefined,
        "sweagent",
      );
      await service.startTaskExecution(task.id ?? "");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.status).toBe("completed");
      expect(
        executionLog.some((e) => e.providerId === "sweagent" && e.completed),
      ).toBe(true);
    });

    it("should track files created and modified", async () => {
      const task = await service.createTask(
        "File Tracking",
        "Create and modify files",
      );
      await service.startTaskExecution(task.id ?? "");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.filesCreated).toContain("new-file.ts");
      expect(updated?.metadata.filesModified).toContain("existing-file.ts");
    });

    it("should append output during execution", async () => {
      const task = await service.createTask("Output Task", "Check output");
      await service.startTaskExecution(task.id ?? "");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.output.length).toBeGreaterThan(0);
      expect(
        updated?.metadata.output.some((o) => o.includes("Starting task")),
      ).toBe(true);
      expect(
        updated?.metadata.output.some((o) => o.includes("completed")),
      ).toBe(true);
    });
  });

  // ============================================================================
  // Task Lifecycle (Pause, Resume, Cancel)
  // ============================================================================

  describe("Task Lifecycle Management", () => {
    it("should pause a running task", async () => {
      const task = await service.createTask("Pause Test", "Test pausing");
      await service.updateTaskStatus(task.id ?? "", "running");
      await service.pauseTask(task.id ?? "");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.status).toBe("paused");
      expect(service.isTaskPaused(task.id ?? "")).toBe(true);
    });

    it("should resume a paused task", async () => {
      const task = await service.createTask("Resume Test", "Test resuming");
      await service.pauseTask(task.id ?? "");
      await service.resumeTask(task.id ?? "");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.status).toBe("running");
      expect(service.isTaskPaused(task.id ?? "")).toBe(false);
    });

    it("should cancel a task", async () => {
      const task = await service.createTask("Cancel Test", "Test cancellation");
      await service.cancelTask(task.id ?? "");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.status).toBe("cancelled");
      expect(service.isTaskCancelled(task.id ?? "")).toBe(true);
    });

    it("should mark task as done (user status)", async () => {
      const task = await service.createTask("Done Test", "Test done status");
      await service.setUserStatus(task.id ?? "", "done");

      const updated = await service.getTask(task.id ?? "");
      expect(updated?.metadata.userStatus).toBe("done");
    });
  });

  // ============================================================================
  // Task Listing and Searching
  // ============================================================================

  describe("Task Listing and Searching", () => {
    beforeEach(async () => {
      await service.createTask(
        "Auth API",
        "Implement authentication",
        undefined,
        "eliza",
      );
      await service.createTask(
        "File Upload",
        "Handle file uploads",
        undefined,
        "claude-code",
      );
      await service.createTask(
        "Database Schema",
        "Design database",
        undefined,
        "codex",
      );
      await service.createTask(
        "Bug Fix #123",
        "Fix critical bug",
        undefined,
        "sweagent",
      );
    });

    it("should list all recent tasks", async () => {
      const tasks = await service.getRecentTasks(10);
      expect(tasks.length).toBe(4);
    });

    it("should search tasks by name", async () => {
      const results = await service.searchTasks("auth");
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("Auth API");
    });

    it("should search tasks by description", async () => {
      const results = await service.searchTasks("database");
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("Database Schema");
    });

    it("should filter tasks by status", async () => {
      const task = await service.getRecentTasks(1);
      if (task[0]) {
        await service.updateTaskStatus(task[0].id ?? "", "completed");
      }

      const completed = await service.getTasksByStatus("completed");
      expect(completed.length).toBe(1);
    });

    it("should list unfinished tasks (pending/running/paused)", async () => {
      const allTasks = await service.getRecentTasks(10);
      // We have 4 tasks from beforeEach

      // Mark one as completed
      if (allTasks[0]) {
        await service.updateTaskStatus(allTasks[0].id ?? "", "completed");
      }

      // Mark one as done by user (but still pending execution status)
      if (allTasks[1]) {
        await service.setUserStatus(allTasks[1].id ?? "", "done");
      }

      const pending = await service.getTasksByStatus("pending");
      // 4 tasks - 1 completed = 3 still pending (execution status)
      expect(pending.length).toBe(3);

      const userOpen = (await service.getTasks()).filter(
        (t) => t.metadata.userStatus === "open",
      );
      // 4 tasks - 1 marked done = 3 still "open" by user status
      expect(userOpen.length).toBe(3);
    });
  });

  // ============================================================================
  // Current Task Management
  // ============================================================================

  describe("Current Task Management", () => {
    it("should auto-select first created task", async () => {
      expect(service.getCurrentTaskId()).toBeNull();

      const task = await service.createTask("First Task", "Description");
      expect(service.getCurrentTaskId()).toBe(task.id);
    });

    it("should allow switching current task", async () => {
      const task1 = await service.createTask("Task 1", "First");
      const task2 = await service.createTask("Task 2", "Second");

      expect(service.getCurrentTaskId()).toBe(task1.id);

      service.setCurrentTask(task2.id ?? null);
      expect(service.getCurrentTaskId()).toBe(task2.id);
    });

    it("should get current task details", async () => {
      const _task = await service.createTask("Current Task", "Get details");
      const current = await service.getCurrentTask();

      expect(current).not.toBeNull();
      expect(current?.name).toBe("Current Task");
    });
  });

  // ============================================================================
  // Task Context (for AI prompts)
  // ============================================================================

  describe("Task Context for AI Prompts", () => {
    it("should provide formatted context for current task", async () => {
      const task = await service.createTask(
        "Context Task",
        "Test context generation",
      );
      await service.appendOutput(
        task.id ?? "",
        "Step 1: Started\nStep 2: Processing",
      );
      await service.addStep(task.id ?? "", "Analyze requirements");
      await service.addStep(task.id ?? "", "Implement solution");

      const context = await service.getTaskContext();

      expect(context).toContain("Context Task");
      expect(context).toContain("pending");
      expect(context).toContain("Analyze requirements");
      expect(context).toContain("Implement solution");
      expect(context).toContain("Step 1: Started");
    });

    it("should include provider information in context", async () => {
      await service.createTask(
        "Provider Task",
        "Check provider",
        undefined,
        "claude-code",
      );
      const context = await service.getTaskContext();

      expect(context).toContain("Claude Code");
    });
  });

  // ============================================================================
  // Event Emission
  // ============================================================================

  describe("Event Emission", () => {
    it("should emit task:created event", async () => {
      const events: string[] = [];
      service.on("task:created", () => events.push("created"));

      await service.createTask("Event Task", "Test events");

      expect(events).toContain("created");
    });

    it("should emit task:progress event", async () => {
      const events: string[] = [];
      service.on("task:progress", () => events.push("progress"));

      const task = await service.createTask("Progress Task", "Test progress");
      await service.updateTaskProgress(task.id ?? "", 50);

      expect(events).toContain("progress");
    });

    it("should emit task:paused event", async () => {
      const events: string[] = [];
      service.on("task:paused", () => events.push("paused"));

      const task = await service.createTask("Pause Event", "Test pause event");
      await service.pauseTask(task.id ?? "");

      expect(events).toContain("paused");
    });

    it("should emit task:cancelled event", async () => {
      const events: string[] = [];
      service.on("task:cancelled", () => events.push("cancelled"));

      const task = await service.createTask(
        "Cancel Event",
        "Test cancel event",
      );
      await service.cancelTask(task.id ?? "");

      expect(events).toContain("cancelled");
    });
  });
});

// ============================================================================
// All 4 Agents - Complete Flow Test
// ============================================================================

describe("All 4 Agents - Complete Flow", () => {
  let service: AgentOrchestratorService;
  let runtime: IAgentRuntime;
  let tasks: Map<string, CodeTask>;
  let taskCounter: number;

  beforeEach(async () => {
    runtime = await createTestRuntime();
    tasks = new Map();
    taskCounter = 0;
    executionLog.length = 0;

    // Setup mocks
    vi.spyOn(runtime, "getRoom").mockResolvedValue(null);
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
        if (updates.metadata) {
          task.metadata = { ...task.metadata, ...updates.metadata };
        }
      },
    );
    vi.spyOn(runtime, "deleteTask").mockImplementation(async (id: UUID) => {
      tasks.delete(id);
    });

    // Configure with all 4 required agents
    configureAgentOrchestratorPlugin({
      providers: [
        createMockProvider("eliza", "Eliza (plugin-code)"),
        createMockProvider("claude-code", "Claude Code"),
        createMockProvider("codex", "Codex"),
        createMockProvider("sweagent", "SWE-agent"),
      ],
      defaultProviderId: "eliza",
      getWorkingDirectory: () => process.cwd(),
    });

    service = (await AgentOrchestratorService.start(
      runtime,
    )) as AgentOrchestratorService;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await cleanupTestRuntime(runtime);
  });

  it("should complete full workflow with eliza (default)", async () => {
    // 1. Create task
    const task = await service.createTask(
      "Build Login Form",
      "Create a TypeScript login form component",
    );
    expect(task.metadata.providerId).toBe("eliza");

    // 2. Execute task
    await service.startTaskExecution(task.id ?? "");

    // 3. Verify completion
    const completed = await service.getTask(task.id ?? "");
    expect(completed?.metadata.status).toBe("completed");
    expect(completed?.metadata.result?.success).toBe(true);

    // 4. Mark as done
    await service.setUserStatus(task.id ?? "", "done");
    const done = await service.getTask(task.id ?? "");
    expect(done?.metadata.userStatus).toBe("done");
  });

  it("should complete full workflow with claude-code", async () => {
    const task = await service.createTask(
      "Refactor API",
      "Refactor the REST API",
      undefined,
      "claude-code",
    );
    await service.startTaskExecution(task.id ?? "");

    const completed = await service.getTask(task.id ?? "");
    expect(completed?.metadata.status).toBe("completed");
    expect(completed?.metadata.providerId).toBe("claude-code");
  });

  it("should complete full workflow with codex", async () => {
    const task = await service.createTask(
      "Generate Tests",
      "Generate unit tests",
      undefined,
      "codex",
    );
    await service.startTaskExecution(task.id ?? "");

    const completed = await service.getTask(task.id ?? "");
    expect(completed?.metadata.status).toBe("completed");
    expect(completed?.metadata.providerId).toBe("codex");
  });

  it("should complete full workflow with sweagent", async () => {
    const task = await service.createTask(
      "Fix Bug",
      "Fix the memory leak",
      undefined,
      "sweagent",
    );
    await service.startTaskExecution(task.id ?? "");

    const completed = await service.getTask(task.id ?? "");
    expect(completed?.metadata.status).toBe("completed");
    expect(completed?.metadata.providerId).toBe("sweagent");
  });

  it("should handle multiple tasks across different agents", async () => {
    // Create tasks for each agent
    const elizaTask = await service.createTask("Task A", "Eliza task");
    const claudeTask = await service.createTask(
      "Task B",
      "Claude task",
      undefined,
      "claude-code",
    );
    const codexTask = await service.createTask(
      "Task C",
      "Codex task",
      undefined,
      "codex",
    );
    const sweTask = await service.createTask(
      "Task D",
      "SWE task",
      undefined,
      "sweagent",
    );

    // Execute all
    await Promise.all([
      service.startTaskExecution(elizaTask.id ?? ""),
      service.startTaskExecution(claudeTask.id ?? ""),
      service.startTaskExecution(codexTask.id ?? ""),
      service.startTaskExecution(sweTask.id ?? ""),
    ]);

    // Verify all completed
    const allTasks = await service.getTasks();
    expect(allTasks.every((t) => t.metadata.status === "completed")).toBe(true);

    // Verify each was routed to correct provider
    expect(executionLog.filter((e) => e.completed).length).toBe(4);
    expect(executionLog.some((e) => e.providerId === "eliza")).toBe(true);
    expect(executionLog.some((e) => e.providerId === "claude-code")).toBe(true);
    expect(executionLog.some((e) => e.providerId === "codex")).toBe(true);
    expect(executionLog.some((e) => e.providerId === "sweagent")).toBe(true);
  });

  it("should list unfinished tasks correctly", async () => {
    // Create tasks
    const _task1 = await service.createTask("Unfinished 1", "Still pending");
    const _task2 = await service.createTask("Unfinished 2", "Also pending");
    const task3 = await service.createTask("Finished", "Will be done");

    // Complete one
    await service.startTaskExecution(task3.id ?? "");

    // Get pending tasks
    const pending = await service.getTasksByStatus("pending");
    expect(pending.length).toBe(2);
    expect(pending.map((t) => t.name)).toContain("Unfinished 1");
    expect(pending.map((t) => t.name)).toContain("Unfinished 2");
  });
});
