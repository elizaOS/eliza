/**
 * Tests for the `dispose` hook on @elizaos/app-lifeops plugin.
 *
 * The hook runs when `runtime.unloadPlugin("@elizaos/app-lifeops")` is
 * called. It should:
 *   1. Delete persisted Task rows for the three lifeops workers
 *      (PROACTIVE_AGENT, LIFEOPS_SCHEDULER, FOLLOWUP_TRACKER_RECONCILE)
 *   2. Unregister the in-memory task worker functions
 *   3. Tolerate per-task failures so one broken delete doesn't block
 *      the others
 */

import type { IAgentRuntime, Task } from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
import { appLifeOpsPlugin } from "../src/plugin.js";

const PROACTIVE_TASK_NAME = "PROACTIVE_AGENT";
const LIFEOPS_TASK_NAME = "LIFEOPS_SCHEDULER";
const FOLLOWUP_TRACKER_TASK_NAME = "FOLLOWUP_TRACKER_RECONCILE";
const AGENT_ID = "00000000-0000-0000-0000-000000000003" as const;

type TaskLike = Pick<Task, "id" | "name">;

interface MakeRuntimeOpts {
  tasks?: TaskLike[];
  deleteTaskError?: string;
  getTasksError?: string;
  unregisterTaskWorker?: ((name: string) => boolean) | null;
}

function makeRuntime(opts: MakeRuntimeOpts = {}) {
  const warn = vi.fn();
  const getTasks = vi.fn(async ({ agentIds }: { agentIds: string[] }) => {
    if (opts.getTasksError && agentIds.includes(AGENT_ID)) {
      throw new Error(opts.getTasksError);
    }
    return (opts.tasks ?? []) as Task[];
  });
  const deleteTask = vi.fn(async (id: string) => {
    if (opts.deleteTaskError === id) {
      throw new Error("boom");
    }
  });
  const unregisterCalls: string[] = [];
  const unregisterTaskWorker =
    opts.unregisterTaskWorker === null
      ? undefined
      : opts.unregisterTaskWorker ??
        vi.fn((name: string) => {
          unregisterCalls.push(name);
          return true;
        });

  const runtime = {
    agentId: AGENT_ID,
    getTasks,
    deleteTask,
    unregisterTaskWorker,
    logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as IAgentRuntime;

  return { runtime, getTasks, deleteTask, unregisterTaskWorker, warn, unregisterCalls };
}

describe("appLifeOpsPlugin.dispose", () => {
  test("is defined as a function on the plugin object", () => {
    expect(appLifeOpsPlugin.dispose).toBeTypeOf("function");
  });

  test("deletes matching task rows for all three lifeops task names", async () => {
    const tasks: TaskLike[] = [
      { id: "t-proactive", name: PROACTIVE_TASK_NAME } as TaskLike,
      { id: "t-scheduler", name: LIFEOPS_TASK_NAME } as TaskLike,
      { id: "t-followup", name: FOLLOWUP_TRACKER_TASK_NAME } as TaskLike,
    ];
    const { runtime, deleteTask } = makeRuntime({ tasks });

    await appLifeOpsPlugin.dispose?.(runtime);

    expect(deleteTask).toHaveBeenCalledWith("t-proactive");
    expect(deleteTask).toHaveBeenCalledWith("t-scheduler");
    expect(deleteTask).toHaveBeenCalledWith("t-followup");
    expect(deleteTask).toHaveBeenCalledTimes(3);
  });

  test("does NOT delete tasks with unrelated names", async () => {
    const tasks: TaskLike[] = [
      { id: "t-proactive", name: PROACTIVE_TASK_NAME } as TaskLike,
      { id: "t-other", name: "SOME_OTHER_TASK" } as TaskLike,
    ];
    const { runtime, deleteTask } = makeRuntime({ tasks });

    await appLifeOpsPlugin.dispose?.(runtime);

    expect(deleteTask).toHaveBeenCalledWith("t-proactive");
    expect(deleteTask).not.toHaveBeenCalledWith("t-other");
  });

  test("unregisters all three task workers", async () => {
    const { runtime, unregisterTaskWorker } = makeRuntime();
    await appLifeOpsPlugin.dispose?.(runtime);

    expect(unregisterTaskWorker).toHaveBeenCalledWith(PROACTIVE_TASK_NAME);
    expect(unregisterTaskWorker).toHaveBeenCalledWith(LIFEOPS_TASK_NAME);
    expect(unregisterTaskWorker).toHaveBeenCalledWith(
      FOLLOWUP_TRACKER_TASK_NAME,
    );
  });

  test("continues past a single deleteTask failure instead of aborting", async () => {
    const tasks: TaskLike[] = [
      { id: "t-proactive", name: PROACTIVE_TASK_NAME } as TaskLike,
      { id: "t-scheduler", name: LIFEOPS_TASK_NAME } as TaskLike,
      { id: "t-followup", name: FOLLOWUP_TRACKER_TASK_NAME } as TaskLike,
    ];
    const { runtime, deleteTask, unregisterTaskWorker, warn } = makeRuntime({
      tasks,
      deleteTaskError: "t-scheduler",
    });

    await expect(appLifeOpsPlugin.dispose?.(runtime)).resolves.toBeUndefined();

    // All three delete attempts were made, even though one failed.
    expect(deleteTask).toHaveBeenCalledTimes(3);
    // All three workers still got unregistered.
    expect(unregisterTaskWorker).toHaveBeenCalledTimes(3);
    // The failure was logged rather than thrown.
    expect(warn).toHaveBeenCalled();
  });

  test("tolerates runtime.unregisterTaskWorker being undefined (older core)", async () => {
    const { runtime, deleteTask } = makeRuntime({
      unregisterTaskWorker: null,
    });
    await expect(appLifeOpsPlugin.dispose?.(runtime)).resolves.toBeUndefined();
    // deleteTask path still runs.
    expect(deleteTask).not.toHaveBeenCalled(); // no tasks in fixture
  });

  test("continues past a getTasks failure for one task name", async () => {
    const { runtime, warn, unregisterTaskWorker } = makeRuntime({
      getTasksError: "boom",
    });
    await expect(appLifeOpsPlugin.dispose?.(runtime)).resolves.toBeUndefined();
    // Workers still unregistered even if listing failed.
    expect(unregisterTaskWorker).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalled();
  });
});
