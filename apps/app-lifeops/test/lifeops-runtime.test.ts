import type { IAgentRuntime, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lifeops/app-state.js", () => ({
  loadLifeOpsAppState: vi.fn(async () => ({ enabled: true })),
}));

vi.mock("../src/lifeops/service.js", () => ({
  LifeOpsService: class LifeOpsService {},
}));

describe("life-ops runtime", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("retries transient task-table startup failures before creating the scheduler task", async () => {
    vi.useFakeTimers();
    const { ensureLifeOpsSchedulerTask } = await import("../src/lifeops/runtime.js");

    const createdTaskId = "lifeops-scheduler-task" as UUID;
    const agentId = "lifeops-runtime-agent" as UUID;
    let getTasksCallCount = 0;

    const runtime = {
      agentId,
      character: { name: "LifeOps Test Agent" },
      getService: vi.fn(() => null),
      updateTask: vi.fn(),
      createTask: vi.fn(async () => createdTaskId),
      getAgent: vi.fn(async () => ({ id: agentId, name: "LifeOps Test Agent" })),
      createAgent: vi.fn(async () => true),
      getTasks: vi.fn(async () => {
        getTasksCallCount += 1;
        if (getTasksCallCount <= 11) {
          throw new Error('relation "tasks" does not exist');
        }
        return [];
      }),
    } as unknown as IAgentRuntime;

    const taskIdPromise = ensureLifeOpsSchedulerTask(runtime);
    for (let attempt = 0; attempt < 9; attempt++) {
      await vi.advanceTimersByTimeAsync(500);
    }

    await expect(taskIdPromise).resolves.toBe(createdTaskId);
    expect(runtime.getTasks).toHaveBeenCalledTimes(13);
    expect(runtime.createTask).toHaveBeenCalledTimes(1);
    expect(runtime.updateTask).not.toHaveBeenCalled();
  });

  it("reruns plugin migrations when the tasks table is still missing after init", async () => {
    const { ensureLifeOpsSchedulerTask } = await import("../src/lifeops/runtime.js");

    const createdTaskId = "lifeops-scheduler-task" as UUID;
    const agentId = "lifeops-runtime-agent" as UUID;
    let tasksTableReady = false;

    const runtime = {
      agentId,
      character: { name: "LifeOps Test Agent" },
      getService: vi.fn(() => null),
      updateTask: vi.fn(),
      createTask: vi.fn(async () => createdTaskId),
      getAgent: vi.fn(async () => ({ id: agentId, name: "LifeOps Test Agent" })),
      createAgent: vi.fn(async () => true),
      runPluginMigrations: vi.fn(async () => {
        tasksTableReady = true;
      }),
      getTasks: vi.fn(async () => {
        if (!tasksTableReady) {
          const error = new Error('relation "tasks" does not exist');
          Object.assign(error, {
            cause: {
              code: "42P01",
              query: 'select * from "tasks"',
            },
          });
          throw error;
        }
        return [];
      }),
    } as unknown as IAgentRuntime;

    await expect(ensureLifeOpsSchedulerTask(runtime)).resolves.toBe(createdTaskId);
    expect(runtime.runPluginMigrations).toHaveBeenCalledTimes(1);
    expect(runtime.getTasks).toHaveBeenCalledTimes(3);
    expect(runtime.createTask).toHaveBeenCalledTimes(1);
  });

  it("recreates the runtime agent before inserting the scheduler task", async () => {
    const { ensureLifeOpsSchedulerTask } = await import("../src/lifeops/runtime.js");

    const createdTaskId = "lifeops-scheduler-task" as UUID;
    const agentId = "lifeops-runtime-agent" as UUID;
    let agentExists = false;

    const runtime = {
      agentId,
      character: { name: "LifeOps Test Agent" },
      getService: vi.fn(() => null),
      updateTask: vi.fn(),
      createTask: vi.fn(async () => createdTaskId),
      getTasks: vi.fn(async () => []),
      getAgent: vi.fn(async () =>
        agentExists ? ({ id: agentId, name: "LifeOps Test Agent" } as never) : null,
      ),
      createAgent: vi.fn(async () => {
        agentExists = true;
        return true;
      }),
    } as unknown as IAgentRuntime;

    await expect(ensureLifeOpsSchedulerTask(runtime)).resolves.toBe(createdTaskId);
    expect(runtime.getAgent).toHaveBeenCalledTimes(2);
    expect(runtime.createAgent).toHaveBeenCalledWith({
      id: agentId,
      name: "LifeOps Test Agent",
    });
    expect(runtime.createTask).toHaveBeenCalledTimes(1);
  });
});
