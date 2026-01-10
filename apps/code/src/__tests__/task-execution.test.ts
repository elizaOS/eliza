import { describe, test, expect, beforeEach } from "bun:test";
import { stringToUuid, type IAgentRuntime, type Task, type UUID } from "@elizaos/core";
import { CodeTaskService } from "../plugin/services/code-task.js";
import type { CodeTask, CodeTaskMetadata } from "../types.js";
import type { SubAgent, SubAgentContext, SubAgentTool } from "../lib/sub-agents/types.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createMockRuntime(): IAgentRuntime {
  const tasks = new Map<string, CodeTask>();
  let taskCounter = 0;
  const agentId = stringToUuid("test-agent");

  const runtime: Partial<IAgentRuntime> = {
    agentId,

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
  };

  return runtime as IAgentRuntime;
}

function createNoopTools(): SubAgentTool[] {
  return [
    {
      name: "noop",
      description: "No-op tool for tests",
      parameters: [],
      execute: async () => ({ success: true, output: "noop" }),
    },
  ];
}

describe("CodeTaskService execution", () => {
  let runtime: IAgentRuntime;
  let service: CodeTaskService;

  beforeEach(async () => {
    delete process.env.ELIZA_CODE_DISABLE_TASK_EXECUTION;
    runtime = createMockRuntime();
    service = (await CodeTaskService.start(runtime)) as CodeTaskService;
  });

  test("startTaskExecution sets running and completes", async () => {
    const task = await service.createCodeTask("Run Me", "desc");
    const taskId = task.id ?? "";
    expect(taskId).not.toBe("");

    const subAgent: SubAgent = {
      name: "test-agent",
      type: "eliza",
      cancel: () => {},
      execute: async (t, ctx) => {
        ctx.onProgress({ taskId: t.id ?? "", progress: 25, message: "quarter" });
        ctx.onMessage("working", "info");
        return { success: true, summary: "ok", filesCreated: [], filesModified: [] };
      },
    };

    await service.startTaskExecution(taskId, { subAgent, tools: createNoopTools() });

    const updated = await service.getTask(taskId);
    expect(updated?.metadata.status).toBe("completed");
    expect(updated?.metadata.output.join("\n")).toContain("Starting:");
    expect(updated?.metadata.output.join("\n")).toContain("quarter");
  });

  test("pause/resume control state is observable by the runner", async () => {
    const task = await service.createCodeTask("Pause Me", "desc");
    const taskId = task.id ?? "";
    expect(taskId).not.toBe("");

    let allowFinish = false;
    let sawPaused = false;
    let sawResumed = false;
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    const subAgent: SubAgent = {
      name: "test-agent",
      type: "eliza",
      cancel: () => {},
      execute: async (_t, ctx: SubAgentContext) => {
        startedResolve?.();
        let wasPaused = false;
        while (!allowFinish) {
          if (ctx.isCancelled()) {
            return {
              success: false,
              summary: "cancelled",
              filesCreated: [],
              filesModified: [],
              error: "Cancelled",
            };
          }

          if (ctx.isPaused?.()) {
            sawPaused = true;
            wasPaused = true;
            await tick();
            continue;
          }

          if (wasPaused) {
            sawResumed = true;
            wasPaused = false;
          }

          await tick();
        }

        return { success: true, summary: "ok", filesCreated: [], filesModified: [] };
      },
    };

    const execPromise = service.startTaskExecution(taskId, { subAgent, tools: createNoopTools() });
    await started;

    await service.pauseTask(taskId);
    expect((await service.getTask(taskId))?.metadata.status).toBe("paused");

    // Give the runner a chance to observe pause.
    await tick();
    expect(sawPaused).toBe(true);

    await service.resumeTask(taskId);
    expect((await service.getTask(taskId))?.metadata.status).toBe("running");

    // Give the runner a chance to observe resume.
    await tick();
    expect(sawResumed).toBe(true);

    allowFinish = true;
    await execPromise;

    expect((await service.getTask(taskId))?.metadata.status).toBe("completed");
  });

  test("cancel during execution leaves task in cancelled status", async () => {
    const task = await service.createCodeTask("Cancel Me", "desc");
    const taskId = task.id ?? "";
    expect(taskId).not.toBe("");

    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });

    const subAgent: SubAgent = {
      name: "test-agent",
      type: "eliza",
      cancel: () => {},
      execute: async (_t, ctx) => {
        startedResolve?.();
        while (!ctx.isCancelled()) {
          await tick();
        }
        return {
          success: false,
          summary: "cancelled",
          filesCreated: [],
          filesModified: [],
          error: "Cancelled by user",
        };
      },
    };

    const execPromise = service.startTaskExecution(taskId, { subAgent, tools: createNoopTools() });
    await started;

    await service.cancelTask(taskId);
    await execPromise;

    const updated = await service.getTask(taskId);
    expect(updated?.metadata.status).toBe("cancelled");
  });

  test("sub-agent trace events are persisted to task metadata", async () => {
    const task = await service.createCodeTask("Trace Me", "desc");
    const taskId = task.id ?? "";
    expect(taskId).not.toBe("");

    const subAgent: SubAgent = {
      name: "test-agent",
      type: "eliza",
      cancel: () => {},
      execute: async (t, ctx) => {
        ctx.onTrace?.({
          kind: "note",
          level: "info",
          message: "hello trace",
          ts: Date.now(),
          seq: 1,
        });
        return { success: true, summary: t.name, filesCreated: [], filesModified: [] };
      },
    };

    await service.startTaskExecution(taskId, { subAgent, tools: createNoopTools() });

    const updated = await service.getTask(taskId);
    const trace = updated?.metadata.trace ?? [];
    expect(trace.some((e) => e.kind === "note" && e.message === "hello trace")).toBe(true);
  });

  test("detectAndPauseInterruptedTasks pauses tasks left in running state", async () => {
    const t1 = await service.createCodeTask("Running Task", "desc");
    const t2 = await service.createCodeTask("Completed Task", "desc");
    const id1 = t1.id ?? "";
    const id2 = t2.id ?? "";
    expect(id1).not.toBe("");
    expect(id2).not.toBe("");

    await service.updateTaskStatus(id1, "running");
    await service.updateTaskStatus(id2, "completed");

    const paused = await service.detectAndPauseInterruptedTasks();
    expect(paused.map((t) => t.id)).toContain(t1.id);

    const updated1 = await service.getTask(id1);
    const updated2 = await service.getTask(id2);

    expect(updated1?.metadata.status).toBe("paused");
    expect(updated1?.metadata.output.join("\n")).toContain("Paused due to restart");
    expect(updated2?.metadata.status).toBe("completed");
  });
});


