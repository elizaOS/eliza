import { EventEmitter } from "node:events";
import {
  type IAgentRuntime,
  Service,
  type Task,
  type TaskMetadata,
  type UUID,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { getConfiguredAgentOrchestratorOptions } from "../config.js";
import type {
  AgentProvider,
  AgentProviderId,
  JsonValue,
  OrchestratedTask,
  OrchestratedTaskMetadata,
  TaskEvent,
  TaskEventType,
  TaskResult,
  TaskStatus,
  TaskStep,
  TaskUserStatus,
} from "../types.js";

type ControlState = { cancelled: boolean; paused: boolean };

function now(): number {
  return Date.now();
}

function clampProgress(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export class AgentOrchestratorService extends Service {
  static serviceType = "CODE_TASK";
  capabilityDescription = "Orchestrates tasks across registered agent providers";

  private currentTaskId: string | null = null;
  private readonly emitter = new EventEmitter();
  private readonly controlStates = new Map<string, ControlState>();
  private readonly executions = new Map<string, Promise<void>>();

  static async start(runtime: IAgentRuntime): Promise<Service> {
    return new AgentOrchestratorService(runtime);
  }

  // ============================================================================
  // Provider resolution
  // ============================================================================

  private getOptions() {
    const opts = getConfiguredAgentOrchestratorOptions();
    if (!opts) {
      throw new Error(
        "AgentOrchestratorService not configured. Call configureAgentOrchestratorPlugin(...) before runtime.initialize().",
      );
    }
    return opts;
  }

  private getActiveProviderId(): AgentProviderId {
    const opts = this.getOptions();
    const envVar = opts.activeProviderEnvVar ?? "ELIZA_CODE_ACTIVE_SUB_AGENT";
    const raw = process.env[envVar];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed.length > 0 ? trimmed : opts.defaultProviderId;
  }

  private getProviderById(id: AgentProviderId): AgentProvider | null {
    const opts = this.getOptions();
    for (const p of opts.providers) {
      if (p.id === id) return p;
    }
    return null;
  }

  // ============================================================================
  // Current task
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

  async getCurrentTask(): Promise<OrchestratedTask | null> {
    if (!this.currentTaskId) return null;
    return this.getTask(this.currentTaskId);
  }

  // ============================================================================
  // CRUD
  // ============================================================================

  async createTask(
    name: string,
    description: string,
    roomId?: UUID,
    providerId?: AgentProviderId,
  ): Promise<OrchestratedTask> {
    const opts = this.getOptions();
    const chosenProviderId = providerId ?? this.getActiveProviderId();
    const provider = this.getProviderById(chosenProviderId);
    if (!provider) {
      throw new Error(
        `Unknown provider "${chosenProviderId}". Available: ${opts.providers
          .map((p) => p.id)
          .join(", ")}`,
      );
    }

    const worldId = await this.resolveWorldId(roomId);
    const workingDirectory = opts.getWorkingDirectory();

    const metadata: OrchestratedTaskMetadata = {
      status: "pending",
      progress: 0,
      output: [],
      steps: [],
      workingDirectory,
      providerId: provider.id,
      providerLabel: provider.label,
      subAgentType: provider.id,
      userStatus: "open",
      userStatusUpdatedAt: now(),
      filesCreated: [],
      filesModified: [],
      createdAt: now(),
    };

    const taskInput = {
      name,
      description,
      worldId,
      // Keep "code"/"queue" for compatibility with existing UIs/tests (e.g. `examples/code`).
      tags: ["code", "queue", "orchestrator", "task"],
      metadata,
      ...(roomId ? { roomId } : {}),
    };

    const taskId = await this.runtime.createTask(taskInput as unknown as Task);

    const task = await this.getTask(taskId);
    if (!task) throw new Error("Failed to create task");

    if (!this.currentTaskId) this.currentTaskId = taskId;

    this.emit("task:created", taskId, { name: task.name, providerId: provider.id });
    return task;
  }

  private async resolveWorldId(roomId: UUID | undefined): Promise<UUID> {
    if (roomId) {
      const room = await this.runtime.getRoom(roomId);
      if (room?.worldId) return room.worldId;
    }
    return this.runtime.agentId;
  }

  async getTask(taskId: string): Promise<OrchestratedTask | null> {
    const t = await this.runtime.getTask(taskId as UUID);
    if (!t) return null;
    return t as unknown as OrchestratedTask;
  }

  async getTasks(): Promise<OrchestratedTask[]> {
    const tasks = await this.runtime.getTasks({ tags: ["orchestrator"] });
    return tasks as unknown as OrchestratedTask[];
  }

  async getRecentTasks(limit = 20): Promise<OrchestratedTask[]> {
    const tasks = await this.getTasks();
    return tasks
      .slice()
      .sort((a, b) => (b.metadata.createdAt ?? 0) - (a.metadata.createdAt ?? 0))
      .slice(0, limit);
  }

  async getTasksByStatus(status: TaskStatus): Promise<OrchestratedTask[]> {
    const tasks = await this.getTasks();
    return tasks.filter((t) => t.metadata.status === status);
  }

  async searchTasks(query: string): Promise<OrchestratedTask[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const tasks = await this.getTasks();
    return tasks.filter((t) => {
      const id = (t.id ?? "").toLowerCase();
      return (
        id.startsWith(q) ||
        t.name.toLowerCase().includes(q) ||
        (t.description ?? "").toLowerCase().includes(q) ||
        (t.tags ?? []).some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }

  // ============================================================================
  // Updates
  // ============================================================================

  async updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    const metadata = { ...task.metadata };
    metadata.status = status;

    if (status === "running" && !metadata.startedAt) metadata.startedAt = now();
    if (status === "completed" || status === "failed" || status === "cancelled") {
      metadata.completedAt = now();
    }

    await this.runtime.updateTask(taskId as UUID, {
      metadata: metadata as unknown as TaskMetadata,
    });
    this.emit(`task:${status}` as TaskEventType, taskId, { status });
  }

  async updateTaskProgress(taskId: string, progress: number): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    const metadata = { ...task.metadata };
    metadata.progress = clampProgress(progress);
    await this.runtime.updateTask(taskId as UUID, {
      metadata: metadata as unknown as TaskMetadata,
    });
    this.emit("task:progress", taskId, { progress: metadata.progress });
  }

  async renameTask(taskId: string, name: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === task.name) return;
    await this.runtime.updateTask(taskId as UUID, { name: trimmed });
    this.emit("task:message", taskId, { message: `Renamed task to: ${trimmed}` });
  }

  async appendOutput(taskId: string, output: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    const metadata = { ...task.metadata };
    const lines = output.split("\n").filter((l) => l.trim().length > 0);
    metadata.output = [...metadata.output, ...lines].slice(-500);
    await this.runtime.updateTask(taskId as UUID, {
      metadata: metadata as unknown as TaskMetadata,
    });
    this.emit("task:output", taskId, { output: lines });
  }

  async addStep(taskId: string, description: string): Promise<TaskStep> {
    const task = await this.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const step: TaskStep = { id: uuidv4(), description, status: "pending" };
    const metadata = { ...task.metadata };
    metadata.steps = [...metadata.steps, step];
    await this.runtime.updateTask(taskId as UUID, {
      metadata: metadata as unknown as TaskMetadata,
    });
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
    const metadata = { ...task.metadata };
    const step = metadata.steps.find((s) => s.id === stepId);
    if (!step) return;
    step.status = status;
    if (output) step.output = output;

    const total = metadata.steps.length;
    if (total > 0) {
      const completed = metadata.steps.filter((s) => s.status === "completed").length;
      metadata.progress = clampProgress((completed / total) * 100);
    }

    await this.runtime.updateTask(taskId as UUID, {
      metadata: metadata as unknown as TaskMetadata,
    });
    this.emit("task:progress", taskId, { progress: metadata.progress });
  }

  async setTaskResult(taskId: string, result: TaskResult): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    const metadata = { ...task.metadata };
    metadata.result = result;
    metadata.filesCreated = result.filesCreated;
    metadata.filesModified = result.filesModified;
    if (metadata.status !== "cancelled") {
      metadata.status = result.success ? "completed" : "failed";
      metadata.completedAt = now();
    }
    if (!result.success && result.error) metadata.error = result.error;
    await this.runtime.updateTask(taskId as UUID, {
      metadata: metadata as unknown as TaskMetadata,
    });
    this.emit(result.success ? "task:completed" : "task:failed", taskId, {
      success: result.success,
      summary: result.summary,
      error: result.error ?? null,
    });
  }

  async setTaskError(taskId: string, error: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    const metadata = { ...task.metadata };
    metadata.error = error;
    if (metadata.status !== "cancelled") {
      metadata.status = "failed";
      metadata.completedAt = now();
    }
    await this.runtime.updateTask(taskId as UUID, {
      metadata: metadata as unknown as TaskMetadata,
    });
    this.emit(metadata.status === "cancelled" ? "task:cancelled" : "task:failed", taskId, {
      error,
    });
  }

  async setUserStatus(taskId: string, userStatus: TaskUserStatus): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    const metadata = { ...task.metadata };
    metadata.userStatus = userStatus;
    metadata.userStatusUpdatedAt = now();
    await this.runtime.updateTask(taskId as UUID, {
      metadata: metadata as unknown as TaskMetadata,
    });
    this.emit("task:progress", taskId, { userStatus });
  }

  async setTaskSubAgentType(taskId: string, nextProviderId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;

    const provider = this.getProviderById(nextProviderId);
    const metadata = { ...task.metadata };
    metadata.providerId = nextProviderId;
    metadata.subAgentType = nextProviderId;
    metadata.providerLabel = provider?.label ?? metadata.providerLabel ?? nextProviderId;

    await this.runtime.updateTask(taskId as UUID, {
      metadata: metadata as unknown as TaskMetadata,
    });
    this.emit("task:message", taskId, { providerId: nextProviderId });
    await this.appendOutput(taskId, `Provider: ${metadata.providerLabel} (${metadata.providerId})`);
  }

  // ============================================================================
  // Control
  // ============================================================================

  async pauseTask(taskId: string): Promise<void> {
    this.setControl(taskId, { paused: true });
    await this.updateTaskStatus(taskId, "paused");
    this.emit("task:paused", taskId);
  }

  async resumeTask(taskId: string): Promise<void> {
    this.setControl(taskId, { paused: false });
    await this.updateTaskStatus(taskId, "running");
    this.emit("task:resumed", taskId);
  }

  async cancelTask(taskId: string): Promise<void> {
    this.setControl(taskId, { cancelled: true, paused: false });
    const task = await this.getTask(taskId);
    if (!task) return;
    const metadata = { ...task.metadata };
    metadata.status = "cancelled";
    metadata.completedAt = now();
    metadata.error = metadata.error || "Cancelled by user";
    await this.runtime.updateTask(taskId as UUID, {
      metadata: metadata as unknown as TaskMetadata,
    });
    this.emit("task:cancelled", taskId, { status: "cancelled" });
  }

  async deleteTask(taskId: string): Promise<void> {
    // Best-effort request cancellation to stop any in-flight runner.
    this.setControl(taskId, { cancelled: true, paused: false });
    await this.runtime.deleteTask(taskId as UUID);
    if (this.currentTaskId === taskId) this.currentTaskId = null;
    this.emit("task:message", taskId, { deleted: true });
  }

  isTaskCancelled(taskId: string): boolean {
    return this.controlStates.get(taskId)?.cancelled ?? false;
  }

  isTaskPaused(taskId: string): boolean {
    return this.controlStates.get(taskId)?.paused ?? false;
  }

  private setControl(taskId: string, patch: Partial<ControlState>): void {
    const current = this.controlStates.get(taskId) ?? { cancelled: false, paused: false };
    this.controlStates.set(taskId, { ...current, ...patch });
  }

  private clearControl(taskId: string): void {
    this.controlStates.delete(taskId);
  }

  // ============================================================================
  // Execution
  // ============================================================================

  startTaskExecution(taskId: string): Promise<void> {
    const existing = this.executions.get(taskId);
    if (existing) return existing;
    const run = this.runTaskExecution(taskId).finally(() => {
      this.executions.delete(taskId);
    });
    this.executions.set(taskId, run);
    return run;
  }

  /**
   * Compatibility: `examples/code` expects to pause tasks that were left "running"
   * after a restart (fresh process).
   */
  async detectAndPauseInterruptedTasks(): Promise<OrchestratedTask[]> {
    const running = await this.getTasksByStatus("running");
    const candidates = running.filter((t) => (t.metadata.userStatus ?? "open") !== "done");

    const paused: OrchestratedTask[] = [];
    for (const t of candidates) {
      const id = t.id ?? "";
      if (!id) continue;
      await this.pauseTask(id);
      await this.appendOutput(id, "Paused due to restart.");
      const updated = await this.getTask(id);
      if (updated) paused.push(updated);
    }
    return paused;
  }

  /**
   * Compatibility alias for `examples/code` naming.
   */
  async createCodeTask(
    name: string,
    description: string,
    roomId?: UUID,
    subAgentType: string = "eliza",
  ): Promise<OrchestratedTask> {
    return this.createTask(name, description, roomId, subAgentType);
  }

  private async runTaskExecution(taskId: string): Promise<void> {
    try {
      const task = await this.getTask(taskId);
      if (!task) return;

      // Reset per-process control state.
      this.clearControl(taskId);
      this.setControl(taskId, { cancelled: false, paused: false });

      const provider = this.getProviderById(task.metadata.providerId);
      if (!provider) {
        throw new Error(`Provider not found: ${task.metadata.providerId}`);
      }

      await this.updateTaskStatus(taskId, "running");
      await this.appendOutput(
        taskId,
        `Starting: ${task.name}\nProvider: ${provider.label} (${provider.id})`,
      );

      const roomId = (task.roomId as UUID | undefined) ?? undefined;
      const worldId = (task.worldId as UUID | undefined) ?? undefined;

      const execCtxBase = {
        runtimeAgentId: this.runtime.agentId,
        workingDirectory: task.metadata.workingDirectory,
        appendOutput: async (line: string) => this.appendOutput(taskId, line),
        updateProgress: async (p: number) => this.updateTaskProgress(taskId, p),
        updateStep: async (stepId: string, status: TaskStatus, output?: string) =>
          this.updateStep(taskId, stepId, status, output),
        isCancelled: () => this.isTaskCancelled(taskId),
        isPaused: () => this.isTaskPaused(taskId),
      } satisfies Omit<import("../types.js").ProviderTaskExecutionContext, "roomId" | "worldId">;

      const execCtx = {
        ...execCtxBase,
        ...(roomId ? { roomId } : {}),
        ...(worldId ? { worldId } : {}),
      };

      const result = await provider.executeTask(task, execCtx);

      await this.setTaskResult(taskId, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.setTaskError(taskId, msg);
    } finally {
      this.clearControl(taskId);
    }
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

  private emit(type: TaskEventType, taskId: string, data?: Record<string, JsonValue>): void {
    const event: TaskEvent = data ? { type, taskId, data } : { type, taskId };
    this.emitter.emit(type, event);
    this.emitter.emit("task", event);
  }

  async stop(): Promise<void> {
    this.emitter.removeAllListeners();
    this.controlStates.clear();
    this.executions.clear();
  }

  // ============================================================================
  // Context (compatibility with `examples/code`)
  // ============================================================================

  async getTaskContext(): Promise<string> {
    const current = await this.getCurrentTask();
    const tasks = await this.getRecentTasks(10);

    if (tasks.length === 0) {
      return "No tasks have been created yet.";
    }

    const lines: string[] = [];

    const active = current ?? tasks[0] ?? null;
    if (active) {
      const m = active.metadata;
      lines.push(`## Current Task (selected): ${active.name}`);
      lines.push(`- **Execution status**: ${m.status}`);
      lines.push(`- **Progress**: ${m.progress}%`);
      lines.push(`- **Provider**: ${m.providerLabel ?? m.providerId}`);
      lines.push("");

      if (active.description) {
        lines.push("### Description");
        lines.push(active.description);
        lines.push("");
      }

      if (m.steps.length > 0) {
        lines.push("### Plan / Steps");
        for (const s of m.steps) {
          lines.push(`- [${s.status}] ${s.description}`);
        }
        lines.push("");
      }

      if (m.output.length > 0) {
        lines.push("### Task Output (history)");
        lines.push("```");
        lines.push(...m.output.slice(-200));
        lines.push("```");
        lines.push("");
      }
    }

    return lines.join("\n").trim();
  }
}
