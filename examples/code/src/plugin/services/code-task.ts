import { EventEmitter } from "node:events";
import { type IAgentRuntime, Service, type UUID } from "@elizaos/core";
import type { GoalData, GoalDataServiceWrapper } from "@elizaos/plugin-goals";
import { createTodoDataService, type TodoData } from "@elizaos/plugin-todo";
import { v4 as uuidv4 } from "uuid";
import { createSubAgent } from "../../lib/sub-agents/registry.js";
import { createTools } from "../../lib/sub-agents/tools.js";
import type {
  McpToolDefinition,
  SubAgent,
  SubAgentTool,
  ToolResult,
} from "../../lib/sub-agents/types.js";
import type {
  CodeTask,
  CodeTaskMetadata,
  JsonValue,
  SubAgentGoal,
  SubAgentTodo,
  SubAgentType,
  TaskEvent,
  TaskEventType,
  TaskResult,
  TaskStatus,
  TaskStep,
  TaskTraceEvent,
  TaskUserStatus,
} from "../../types.js";
import { getCwd } from "../providers/cwd.js";

/**
 * CodeTaskService - Manages code tasks using core runtime.
 * Wraps runtime.createTask/getTasks with code-specific functionality.
 */
interface TaskExecutionControlState {
  cancelled: boolean;
  paused: boolean;
}

export interface TaskExecutionOptions {
  /**
   * Optional override for testing / custom execution.
   * If omitted, a default Eliza sub-agent will be created.
   */
  subAgent?: SubAgent;
  /**
   * Optional tool set override (useful for tests).
   * If omitted, tools will be created from the task working directory.
   */
  tools?: SubAgentTool[];
}

export class CodeTaskService extends Service {
  static serviceType = "CODE_TASK";
  capabilityDescription =
    "Manages code development tasks with sub-agent execution";

  private currentTaskId: string | null = null;
  private emitter = new EventEmitter();
  private readonly controlStates = new Map<string, TaskExecutionControlState>();
  private readonly executions = new Map<string, Promise<void>>();

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CodeTaskService(runtime);
    return service;
  }

  // ============================================================================
  // Current Task Management
  // ============================================================================

  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  setCurrentTask(taskId: string | null): void {
    this.currentTaskId = taskId;
    if (taskId) {
      this.emit("task:progress", taskId, { selected: true });
    }
  }

  async getCurrentTask(): Promise<CodeTask | null> {
    if (!this.currentTaskId) return null;
    return this.getTask(this.currentTaskId);
  }

  // ============================================================================
  // Task CRUD (wraps core runtime)
  // ============================================================================

  async createCodeTask(
    name: string,
    description: string,
    roomId?: UUID,
    subAgentType: SubAgentType = "eliza",
  ): Promise<CodeTask> {
    // NOTE: The SQL adapter requires `worldId` when creating tasks.
    // When we have a roomId, prefer the room's worldId; otherwise fall back to the agentId.
    const worldId = await this.resolveWorldId(roomId);

    const metadata: CodeTaskMetadata = {
      status: "pending",
      progress: 0,
      output: [],
      steps: [],
      trace: [],
      userStatus: "open",
      userStatusUpdatedAt: Date.now(),
      filesCreated: [],
      filesModified: [],
      workingDirectory: getCwd(),
      subAgentType,
      createdAt: Date.now(),
    };

    const taskId = await this.runtime.createTask({
      name,
      description,
      roomId,
      worldId,
      tags: ["code", "queue"],
      metadata,
    });

    const task = await this.getTask(taskId);
    if (!task) throw new Error("Failed to create task");

    // Auto-select first task
    if (!this.currentTaskId) {
      this.currentTaskId = taskId;
    }

    this.emit("task:created", taskId, { name: task.name });
    return task;
  }

  private async resolveWorldId(roomId: UUID | undefined): Promise<UUID> {
    if (roomId) {
      const room = await this.runtime.getRoom(roomId);
      if (room?.worldId) return room.worldId;
    }
    return this.runtime.agentId;
  }

  async getTask(taskId: string): Promise<CodeTask | null> {
    const task = await this.runtime.getTask(taskId as UUID);
    if (!task) return null;
    return task as CodeTask;
  }

  async getTasks(): Promise<CodeTask[]> {
    const tasks = await this.runtime.getTasks({ tags: ["code"] });
    return tasks as CodeTask[];
  }

  async getRecentTasks(limit = 20): Promise<CodeTask[]> {
    const tasks = await this.getTasks();
    return tasks
      .sort((a, b) => {
        const aTime = (a.metadata as CodeTaskMetadata)?.createdAt ?? 0;
        const bTime = (b.metadata as CodeTaskMetadata)?.createdAt ?? 0;
        return bTime - aTime;
      })
      .slice(0, limit);
  }

  async searchTasks(query: string): Promise<CodeTask[]> {
    const tasks = await this.getTasks();
    const q = query.toLowerCase();

    return tasks.filter(
      (t) =>
        t.id?.toLowerCase().startsWith(q) ||
        t.name.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        t.tags?.some((tag) => tag.toLowerCase().includes(q)),
    );
  }

  async renameTask(taskId: string, name: string): Promise<void> {
    const next = name.trim();
    if (!next) return;
    await this.runtime.updateTask(taskId as UUID, { name: next });
    this.emit("task:message", taskId, { renamed: true, name: next });
  }

  async setTaskSubAgentType(taskId: string, subAgentType: SubAgentType): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    metadata.subAgentType = subAgentType;
    await this.runtime.updateTask(taskId as UUID, { metadata });
    this.emit("task:message", taskId, { subAgentType });
    await this.appendOutput(taskId, `Sub-agent: ${subAgentType}`);
  }

  async getTasksByStatus(status: TaskStatus): Promise<CodeTask[]> {
    const tasks = await this.getTasks();
    return tasks.filter(
      (t) => (t.metadata as CodeTaskMetadata)?.status === status,
    );
  }

  // ============================================================================
  // Task Updates
  // ============================================================================

  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    metadata.status = status;

    if (status === "running" && !metadata.startedAt) {
      metadata.startedAt = Date.now();
    }
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      metadata.completedAt = Date.now();
    }

    await this.runtime.updateTask(taskId as UUID, { metadata });
    this.emit(`task:${status}` as TaskEventType, taskId, { status });
  }

  async updateTaskProgress(taskId: string, progress: number): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    metadata.progress = Math.min(100, Math.max(0, progress));

    await this.runtime.updateTask(taskId as UUID, { metadata });
    this.emit("task:progress", taskId, { progress: metadata.progress });
  }

  async appendOutput(taskId: string, output: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    const lines = output.split("\n").filter((l) => l.length > 0);
    metadata.output = [...metadata.output, ...lines].slice(-500); // Keep last 500 lines

    await this.runtime.updateTask(taskId as UUID, { metadata });
    this.emit("task:output", taskId, { output: lines });
  }

  async appendTrace(taskId: string, event: TaskTraceEvent): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    const existing = Array.isArray(metadata.trace) ? metadata.trace : [];
    const maxEvents = getTaskTraceMaxEvents();
    metadata.trace = [...existing, event].slice(-maxEvents);

    await this.runtime.updateTask(taskId as UUID, { metadata });
    this.emit("task:trace", taskId, { count: metadata.trace.length });
  }

  async addStep(taskId: string, description: string): Promise<TaskStep> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const step: TaskStep = {
      id: uuidv4(),
      description,
      status: "pending",
    };

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    metadata.steps = [...metadata.steps, step];

    await this.runtime.updateTask(taskId as UUID, { metadata });
    return step;
  }

  async updateStep(
    taskId: string,
    stepId: string,
    status: TaskStatus,
    output?: string,
  ): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    const step = metadata.steps.find((s) => s.id === stepId);
    if (!step) return;

    step.status = status;
    if (output) step.output = output;

    // Update progress based on completed steps
    const completed = metadata.steps.filter(
      (s) => s.status === "completed",
    ).length;
    metadata.progress = Math.round((completed / metadata.steps.length) * 100);

    await this.runtime.updateTask(taskId as UUID, { metadata });
    this.emit("task:progress", taskId, {
      progress: metadata.progress,
    });
  }

  async setTaskResult(taskId: string, result: TaskResult): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    metadata.result = result;
    metadata.filesCreated = result.filesCreated;
    metadata.filesModified = result.filesModified;

    // Respect explicit cancellation (e.g., user cancelled while the sub-agent was running)
    if (metadata.status !== "cancelled") {
      metadata.status = result.success ? "completed" : "failed";
      metadata.completedAt = Date.now();
    }
    if (!result.success && result.error) {
      metadata.error = result.error;
    }

    await this.runtime.updateTask(taskId as UUID, { metadata });
    if (metadata.status === "cancelled") {
      this.emit("task:cancelled", taskId, {
        success: false,
        summary: result.summary,
      });
    } else {
      this.emit(result.success ? "task:completed" : "task:failed", taskId, {
        success: result.success,
        summary: result.summary,
        error: result.error ?? null,
      });
    }
  }

  async setTaskError(taskId: string, error: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    metadata.error = error;
    if (metadata.status !== "cancelled") {
      metadata.status = "failed";
      metadata.completedAt = Date.now();
    }

    await this.runtime.updateTask(taskId as UUID, { metadata });
    this.emit(
      metadata.status === "cancelled" ? "task:cancelled" : "task:failed",
      taskId,
      { error },
    );
  }

  async setUserStatus(
    taskId: string,
    userStatus: TaskUserStatus,
  ): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    metadata.userStatus = userStatus;
    metadata.userStatusUpdatedAt = Date.now();

    await this.runtime.updateTask(taskId as UUID, { metadata });
    this.emit("task:progress", taskId, { userStatus });
  }

  // ============================================================================
  // Task Control
  // ============================================================================

  async pauseTask(taskId: string): Promise<void> {
    this.setControlState(taskId, { paused: true });
    await this.updateTaskStatus(taskId, "paused");
    this.emit("task:paused", taskId);
  }

  async resumeTask(taskId: string): Promise<void> {
    this.setControlState(taskId, { paused: false });
    await this.updateTaskStatus(taskId, "running");
    this.emit("task:resumed", taskId);
  }

  async cancelTask(taskId: string): Promise<void> {
    this.setControlState(taskId, { cancelled: true, paused: false });

    const task = await this.getTask(taskId);
    if (!task) return;

    const metadata = { ...task.metadata } as CodeTaskMetadata;
    metadata.status = "cancelled";
    metadata.completedAt = Date.now();
    metadata.error = metadata.error || "Cancelled by user";

    await this.runtime.updateTask(taskId as UUID, { metadata });
    this.emit("task:cancelled", taskId, { status: "cancelled" });
  }

  async deleteTask(taskId: string): Promise<void> {
    // Best-effort request cancellation to stop any in-flight runner
    this.setControlState(taskId, { cancelled: true, paused: false });
    await this.runtime.deleteTask(taskId as UUID);
    if (this.currentTaskId === taskId) {
      this.currentTaskId = null;
    }
    this.emit("task:message", taskId, { deleted: true });
  }

  // ============================================================================
  // Execution (sub-agent runner)
  // ============================================================================

  /**
   * Start (or resume) a task's background execution.
   *
   * - Concurrency-safe: if the task is already executing in this process, returns the existing promise.
   * - Clears any paused/cancelled control state before starting.
   */
  startTaskExecution(
    taskId: string,
    options?: TaskExecutionOptions,
  ): Promise<void> {
    // Allow disabling background execution for tests and constrained environments.
    if (process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION === "1") {
      return Promise.resolve();
    }

    const existing = this.executions.get(taskId);
    if (existing) return existing;

    const run = this.runTaskExecution(taskId, options)
      .catch(() => {
        // Errors are persisted into task metadata via setTaskError; no need to throw.
      })
      .finally(() => {
        this.executions.delete(taskId);
      });

    this.executions.set(taskId, run);
    return run;
  }

  /**
   * Detect tasks that were previously marked as running (but this process is fresh),
   * pause them, and append a note explaining that they can be resumed.
   *
   * This supports the "resume on restart" flow in the TUI.
   */
  async detectAndPauseInterruptedTasks(): Promise<CodeTask[]> {
    const running = await this.getTasksByStatus("running");
    const candidates = running.filter(
      (t) => (t.metadata.userStatus ?? "open") !== "done",
    );

    const paused: CodeTask[] = [];
    for (const task of candidates) {
      const id = task.id ?? "";
      if (!id) continue;
      await this.pauseTask(id);
      await this.appendOutput(id, "Paused due to restart.");
      const updated = await this.getTask(id);
      if (updated) paused.push(updated);
    }

    return paused;
  }

  private async runTaskExecution(
    taskId: string,
    options?: TaskExecutionOptions,
  ): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    // Reset control state (in case this task was previously paused/cancelled in this process).
    this.clearControlState(taskId);
    this.setControlState(taskId, { cancelled: false, paused: false });

    const workingDirectory = task.metadata.workingDirectory;
    const wasPaused = task.metadata.status === "paused";

    await this.updateTaskStatus(taskId, "running");
    await this.appendOutput(
      taskId,
      wasPaused ? `Resuming: ${task.name}` : `Starting: ${task.name}`,
    );

    const requestedType = task.metadata.subAgentType ?? "eliza";
    const subAgent =
      options?.subAgent ??
      createSubAgent(
        requestedType === "claude" ? "claude-code" : requestedType,
      );
    const tools = options?.tools ?? createTools(workingDirectory);

    try {
      const extras = await this.buildSubAgentContextExtras(task, tools);
      const result = await subAgent.execute(task, {
        runtime: this.runtime,
        workingDirectory,
        tools,
        onProgress: (update) => {
          this.updateTaskProgress(taskId, update.progress).catch(() => {});
          if (update.message) {
            this.appendOutput(taskId, update.message).catch(() => {});
          }
        },
        onMessage: (msg, priority) => {
          this.appendOutput(taskId, msg).catch(() => {});
          this.emit("task:message", taskId, {
            message: msg,
            priority,
          });
          if (priority === "error") {
            // Avoid throwing; error details are persisted via task output and metadata.
          }
        },
        onTrace: (event) => {
          this.appendTrace(taskId, event).catch(() => {});
        },
        isCancelled: () => this.isTaskCancelled(taskId),
        isPaused: () => this.isTaskPaused(taskId),
        ...extras,
      });

      await this.setTaskResult(taskId, result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await this.setTaskError(taskId, error);
    } finally {
      this.clearControlState(taskId);
    }
  }

  // ============================================================================
  // Execution Control (in-memory, per-process)
  // ============================================================================

  isTaskCancelled(taskId: string): boolean {
    return this.controlStates.get(taskId)?.cancelled ?? false;
  }

  isTaskPaused(taskId: string): boolean {
    return this.controlStates.get(taskId)?.paused ?? false;
  }

  clearControlState(taskId: string): void {
    this.controlStates.delete(taskId);
  }

  private setControlState(
    taskId: string,
    updates: Partial<TaskExecutionControlState>,
  ): void {
    const current: TaskExecutionControlState = this.controlStates.get(
      taskId,
    ) ?? {
      cancelled: false,
      paused: false,
    };
    this.controlStates.set(taskId, { ...current, ...updates });
  }

  // ============================================================================
  // Sub-agent context enrichment (MCP / goals / todos)
  // ============================================================================

  private async buildSubAgentContextExtras(
    task: CodeTask,
    tools: SubAgentTool[],
  ): Promise<{
    mcpTools?: McpToolDefinition[];
    callMcpTool?: (
      server: string,
      toolName: string,
      args: Record<string, string>,
    ) => Promise<ToolResult>;
    goals?: SubAgentGoal[];
    todos?: SubAgentTodo[];
    createTodo?: (name: string, description?: string) => Promise<SubAgentTodo>;
    completeTodo?: (id: string) => Promise<void>;
  }> {
    const [mcpTools, callMcpTool] = await this.getMcpTooling();
    const goals = await this.getActiveGoals();
    const { todos, createTodo, completeTodo } = await this.getTodoTooling(task);

    return {
      mcpTools,
      callMcpTool,
      goals,
      todos,
      createTodo,
      completeTodo,
    };
  }

  private async getMcpTooling(): Promise<
    [
      McpToolDefinition[] | undefined,
      ((
        server: string,
        toolName: string,
        args: Record<string, string>,
      ) => Promise<ToolResult>) | undefined,
    ]
  > {
    type McpTool = {
      name: string;
      description?: string;
      inputSchema?: {
        type?: string;
        properties?: Record<
          string,
          { type?: string; description?: string }
        >;
        required?: string[];
      };
    };
    type McpServer = {
      name: string;
      tools?: readonly McpTool[];
    };
    type McpCallResult = {
      content: ReadonlyArray<
        | { type: "text"; text: string }
        | { type: string; [k: string]: JsonValue | undefined }
      >;
      isError?: boolean;
    };
    type McpServiceLike = {
      getServers: () => McpServer[];
      callTool: (
        serverName: string,
        toolName: string,
        toolArguments?: Readonly<Record<string, JsonValue>>,
      ) => Promise<McpCallResult>;
    };

    const svc = this.runtime.getService("mcp") as McpServiceLike | null;
    if (!svc) return [undefined, undefined];

    const servers = svc.getServers();
    const defs: McpToolDefinition[] = [];
    for (const s of servers) {
      for (const t of s.tools ?? []) {
        const props = t.inputSchema?.properties ?? {};
        const simplifiedProps: Record<
          string,
          { type: string; description: string }
        > = {};
        for (const [k, v] of Object.entries(props)) {
          simplifiedProps[k] = {
            type: v.type ?? "string",
            description: v.description ?? "",
          };
        }
        defs.push({
          server: s.name,
          name: t.name,
          description: t.description ?? "",
          inputSchema: {
            type: "object",
            properties: simplifiedProps,
            required: (t.inputSchema?.required ?? []) as string[],
          },
        });
      }
    }

    const callMcpTool = async (
      server: string,
      toolName: string,
      args: Record<string, string>,
    ): Promise<ToolResult> => {
      const result = await svc.callTool(server, toolName, args);
      const textParts: string[] = [];
      for (const c of result.content) {
        if (c.type === "text") {
          textParts.push(c.text);
        } else {
          textParts.push(`[${c.type}]`);
        }
      }
      return {
        success: result.isError !== true,
        output: textParts.join("\n").trim() || "(no output)",
      };
    };

    return [defs, callMcpTool];
  }

  private async getActiveGoals(): Promise<SubAgentGoal[] | undefined> {
    const wrapper = this.runtime.getService(
      "GOAL_DATA",
    ) as GoalDataServiceWrapper | null;
    const service = wrapper?.getDataService?.() ?? null;
    if (!service) return undefined;

    const raw = (await service.getUncompletedGoals(
      "agent",
      this.runtime.agentId,
    )) as GoalData[];

    return raw.map((g) => ({
      id: String(g.id),
      name: g.name,
      description: g.description ?? undefined,
      isCompleted: g.isCompleted,
      tags: g.tags ?? undefined,
    }));
  }

  private async getTodoTooling(task: CodeTask): Promise<{
    todos: SubAgentTodo[] | undefined;
    createTodo: ((name: string, description?: string) => Promise<SubAgentTodo>) | undefined;
    completeTodo: ((id: string) => Promise<void>) | undefined;
  }> {
    // Only enable todo tooling when the Todo plugin is actually loaded.
    // In unit tests, we often run without plugin-todo migrations/services.
    const todoPluginPresent =
      this.runtime.getService("TODO_REMINDER") !== null ||
      this.runtime.getService("TODO_INTEGRATION_BRIDGE") !== null;
    if (!todoPluginPresent) {
      return { todos: undefined, createTodo: undefined, completeTodo: undefined };
    }

    if (!this.runtime.db) {
      return { todos: undefined, createTodo: undefined, completeTodo: undefined };
    }

    const todoService = createTodoDataService(this.runtime);

    const roomId = (task.roomId ?? this.runtime.agentId) as UUID;
    const worldId = await this.resolveWorldId(roomId);
    const entityId = this.runtime.agentId;

    const raw = await todoService.getTodos({
      agentId: this.runtime.agentId,
      worldId,
      roomId,
      entityId,
      isCompleted: false,
      limit: 50,
    });

    const todos: SubAgentTodo[] = raw.map((t: TodoData) => ({
      id: String(t.id),
      name: t.name,
      description: t.description ?? undefined,
      type: t.type,
      priority:
        typeof t.priority === "number" &&
        (t.priority === 1 ||
          t.priority === 2 ||
          t.priority === 3 ||
          t.priority === 4)
          ? t.priority
          : undefined,
      isCompleted: t.isCompleted,
      isUrgent: t.isUrgent,
    }));

    const createTodo = async (
      name: string,
      description?: string,
    ): Promise<SubAgentTodo> => {
      const id = await todoService.createTodo({
        agentId: this.runtime.agentId,
        worldId,
        roomId,
        entityId,
        name,
        description,
        type: "one-off",
        isUrgent: false,
        priority: 3,
        metadata: {},
        tags: ["code-task"],
      });
      const created = await todoService.getTodo(id);
      if (!created) {
        throw new Error("Todo creation failed");
      }
      return {
        id: String(created.id),
        name: created.name,
        description: created.description ?? undefined,
        type: created.type,
        priority:
          typeof created.priority === "number" &&
          (created.priority === 1 ||
            created.priority === 2 ||
            created.priority === 3 ||
            created.priority === 4)
            ? (created.priority as 1 | 2 | 3 | 4)
            : undefined,
        isCompleted: created.isCompleted,
        isUrgent: created.isUrgent,
      };
    };

    const completeTodo = async (id: string): Promise<void> => {
      await todoService.updateTodo(id as UUID, {
        isCompleted: true,
        completedAt: new Date(),
      });
    };

    return { todos, createTodo, completeTodo };
  }

  // ============================================================================
  // Events
  // ============================================================================

  on(event: TaskEventType | "task", handler: (e: TaskEvent) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: TaskEventType | "task", handler: (e: TaskEvent) => void): void {
    this.emitter.off(event, handler);
  }

  private emit(
    type: TaskEventType,
    taskId: string,
    data?: Record<string, JsonValue>,
  ): void {
    const event: TaskEvent = { type, taskId, data };
    this.emitter.emit(type, event);
    this.emitter.emit("task", event);
  }

  // ============================================================================
  // Context for Providers
  // ============================================================================

  async getTaskContext(): Promise<string> {
    const current = await this.getCurrentTask();
    const tasks = await this.getRecentTasks(10);

    if (tasks.length === 0) {
      return "No tasks have been created yet.";
    }

    const maxOutputCharsRaw =
      process.env.ELIZA_CODE_TASK_CONTEXT_MAX_OUTPUT_CHARS;
    const maxOutputChars = (() => {
      if (!maxOutputCharsRaw) return 20000;
      const parsed = Number.parseInt(maxOutputCharsRaw, 10);
      return Number.isFinite(parsed) && parsed > 1000 ? parsed : 20000;
    })();

    const lines: string[] = [];

    if (current) {
      const m = current.metadata;
      const taskId = current.id ? String(current.id) : "";
      const shortId = taskId ? taskId.slice(0, 8) : "unknown";

      lines.push(`## Current Task (selected): ${current.name}`);
      lines.push(`- **ID**: ${shortId}`);
      lines.push(`- **User status**: ${m.userStatus ?? "open"}`);
      lines.push(
        `- **Execution status**: ${getStatusEmoji(m.status)} ${m.status}`,
      );
      lines.push(`- **Progress**: ${m.progress}%`);
      lines.push(`- **Working directory**: ${m.workingDirectory}`);
      if (m.subAgentType) lines.push(`- **Sub-agent**: ${m.subAgentType}`);
      lines.push(`- **Created**: ${formatTimestamp(m.createdAt)}`);
      if (m.startedAt)
        lines.push(`- **Started**: ${formatTimestamp(m.startedAt)}`);
      if (m.completedAt)
        lines.push(`- **Completed**: ${formatTimestamp(m.completedAt)}`);
      lines.push("");

      if (current.description) {
        lines.push("### Description");
        lines.push(current.description);
        lines.push("");
      }

      if (m.steps.length > 0) {
        lines.push("### Plan / Steps");
        for (const step of m.steps) {
          const outputSuffix = step.output
            ? ` — ${truncate(step.output, 140)}`
            : "";
          lines.push(
            `- [${getStatusEmoji(step.status)}] ${step.description}${outputSuffix}`,
          );
        }
        lines.push("");
      }

      if (m.output.length > 0) {
        const totalLines = m.output.length;
        const { included, omitted } = takeTailByCharBudget(
          m.output,
          maxOutputChars,
        );
        lines.push(`### Task Output (history)`);
        lines.push(
          `Total lines stored: ${totalLines}. Showing last ${included.length}${omitted > 0 ? ` (omitted ${omitted} earlier)` : ""}.`,
        );
        lines.push("```");
        lines.push(...included);
        lines.push("```");
        lines.push("");
      }

      if (m.error) {
        lines.push("### Error");
        lines.push("```");
        lines.push(m.error);
        lines.push("```");
        lines.push("");
      }

      const created = m.filesCreated ?? m.result?.filesCreated ?? [];
      const modified = m.filesModified ?? m.result?.filesModified ?? [];
      if (created.length > 0 || modified.length > 0) {
        lines.push("### Files");
        if (created.length > 0) {
          lines.push(
            `- Created: ${created.slice(0, 30).join(", ")}${created.length > 30 ? "..." : ""}`,
          );
        }
        if (modified.length > 0) {
          lines.push(
            `- Modified: ${modified.slice(0, 30).join(", ")}${modified.length > 30 ? "..." : ""}`,
          );
        }
        lines.push("");
      }

      if (m.result) {
        lines.push("### Result");
        lines.push(`- **Success**: ${m.result.success ? "yes" : "no"}`);
        lines.push(`- **Summary**: ${truncate(m.result.summary, 300)}`);
        lines.push("");
      }
    }

    // Summary of other tasks
    const others = tasks.filter((t) => t.id !== current?.id);
    if (others.length > 0) {
      lines.push("## Other Tasks");
      for (const task of others.slice(0, 5)) {
        const m = task.metadata;
        const id = task.id ? String(task.id).slice(0, 8) : "unknown";
        lines.push(
          `- [${getStatusEmoji(m.status)}] **${task.name}** (${m.progress}%) — ${id}`,
        );
      }
      lines.push("");
    }

    // Stats
    const running = tasks.filter((t) => t.metadata.status === "running").length;
    const completed = tasks.filter(
      (t) => t.metadata.status === "completed",
    ).length;
    const failed = tasks.filter((t) => t.metadata.status === "failed").length;
    const cancelled = tasks.filter(
      (t) => t.metadata.status === "cancelled",
    ).length;
    const pending = tasks.filter((t) => t.metadata.status === "pending").length;

    lines.push(`## Summary`);
    lines.push(
      `${running} running, ${completed} done, ${failed} failed, ${cancelled} cancelled, ${pending} pending`,
    );

    return lines.join("\n").trim();
  }

  async stop(): Promise<void> {
    this.emitter.removeAllListeners();
    this.controlStates.clear();
    this.executions.clear();
  }
}

function getTaskTraceMaxEvents(): number {
  const raw = process.env.ELIZA_CODE_TASK_TRACE_MAX_EVENTS;
  if (!raw) return 600;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 600;
  if (parsed < 50) return 50;
  if (parsed > 5000) return 5000;
  return parsed;
}

function getStatusEmoji(status: TaskStatus): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "running":
      return "🔄";
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "paused":
      return "⏸️";
    case "cancelled":
      return "🛑";
    default:
      return "❓";
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatTimestamp(ms: number | undefined): string {
  if (!ms) return "unknown";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "unknown";
  }
}

function takeTailByCharBudget(
  lines: string[],
  maxChars: number,
): { included: string[]; omitted: number } {
  // Include as many lines from the end as will fit within maxChars (including newlines).
  const included: string[] = [];
  let used = 0;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const cost = line.length + 1; // +1 for newline
    if (included.length > 0 && used + cost > maxChars) break;
    if (included.length === 0 && cost > maxChars) {
      // Single giant line: truncate it.
      included.unshift(truncate(line, Math.max(1000, maxChars - 20)));
      used = included[0].length + 1;
      break;
    }
    included.unshift(line);
    used += cost;
  }

  const omitted = Math.max(0, lines.length - included.length);
  return { included, omitted };
}
