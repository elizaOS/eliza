/** Verifies ensureLifeOpsSchedulerTask creates exactly one scheduler task and resolves the polling interval. Deterministic vitest with a stubbed runtime. */
import type { IAgentRuntime, Task, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  ensureLifeOpsSchedulerTask,
  isMissingLifeOpsRelationError,
  LIFEOPS_TASK_NAME,
  LIFEOPS_TASK_TAGS,
  resolveLifeOpsTaskIntervalMs,
} from "./scheduler-task.js";

const AGENT_ID = "00000000-0000-0000-0000-0000000000cc" as UUID;

function makeRuntime(existingTasks: Task[]) {
  const updateTask = vi.fn(async () => undefined);
  const createTask = vi.fn(async () => "created-task-id" as UUID);
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Test" },
    getTasks: vi.fn(async (params: { tags?: string[] }) => {
      if (params.tags?.includes("__db_ready_probe__")) return [];
      return existingTasks;
    }),
    getAgent: vi.fn(async () => ({ id: AGENT_ID, name: "Test" })),
    createAgent: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    updateTask,
    createTask,
  } as unknown as IAgentRuntime;
  return { runtime, updateTask, createTask };
}

describe("ensureLifeOpsSchedulerTask heartbeat self-heal", () => {
  it("clears paused + failure counters and sets never-pause on an existing bricked heartbeat", async () => {
    const bricked: Task = {
      id: "task-bricked" as UUID,
      name: LIFEOPS_TASK_NAME,
      agentId: AGENT_ID,
      tags: [...LIFEOPS_TASK_TAGS],
      metadata: {
        // State persisted by older builds after 5 consecutive tick failures.
        paused: true,
        failureCount: 5,
        lastError: "db outage",
        updateInterval: 300_000, // backoff-inflated
        baseInterval: 60_000,
        blocking: true,
        customFlag: "keep-me",
        lifeopsScheduler: { kind: "runtime_runner", version: 1 },
      },
    };
    const { runtime, updateTask, createTask } = makeRuntime([bricked]);

    const id = await ensureLifeOpsSchedulerTask(runtime);

    expect(id).toBe("task-bricked");
    expect(createTask).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledTimes(1);
    const [taskId, patch] = updateTask.mock.calls[0] as unknown as [
      UUID,
      { metadata: Record<string, unknown> },
    ];
    expect(taskId).toBe("task-bricked");
    const meta = patch.metadata;
    expect(meta.paused).toBe(false);
    expect(meta.failureCount).toBe(0);
    expect(meta.lastError).toBeUndefined();
    expect(meta.maxFailures).toBe(0); // <= 0 => core never auto-pauses
    const interval = resolveLifeOpsTaskIntervalMs(AGENT_ID);
    expect(meta.updateInterval).toBe(interval); // backoff-inflated interval reset
    expect(meta.baseInterval).toBe(interval);
    expect(meta.customFlag).toBe("keep-me"); // unrelated metadata preserved
    expect(meta.lifeopsScheduler).toEqual({
      kind: "runtime_runner",
      version: 1,
    });
  });

  it("creates the heartbeat with never-pause metadata when none exists", async () => {
    const { runtime, updateTask, createTask } = makeRuntime([]);

    const id = await ensureLifeOpsSchedulerTask(runtime);

    expect(id).toBe("created-task-id");
    expect(updateTask).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledTimes(1);
    const [task] = createTask.mock.calls[0] as unknown as [Task];
    expect(task.name).toBe(LIFEOPS_TASK_NAME);
    expect(task.tags).toEqual([...LIFEOPS_TASK_TAGS]);
    const meta = task.metadata as Record<string, unknown>;
    expect(meta.maxFailures).toBe(0);
    expect(meta.paused).toBe(false);
    expect(meta.failureCount).toBe(0);
  });
});

describe("isMissingLifeOpsRelationError", () => {
  it("detects a missing app_lifeops relation through error causes", () => {
    const error = new Error("query failed", {
      cause: new Error(
        'relation "app_lifeops.lifeops_occurrences" does not exist',
      ),
    });
    expect(isMissingLifeOpsRelationError(error)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isMissingLifeOpsRelationError(new Error("connection reset"))).toBe(
      false,
    );
  });
});
