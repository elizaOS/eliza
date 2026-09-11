/** Verifies the LifeOps scheduler tick processes scheduled work and surfaces subsystem failures rather than swallowing them. Deterministic vitest with the scheduled-work path mocked. */
import type { IAgentRuntime, Task, TaskWorker, UUID } from "@elizaos/core";
import { TaskService } from "@elizaos/core/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { escalateUnacknowledgedIntents } from "./intent-sync.js";
import {
  executeLifeOpsReminderTask,
  executeLifeOpsSchedulerTask,
  registerLifeOpsTaskWorker,
  resolveLifeOpsTaskIntervalMs,
} from "./runtime.js";

const scheduledWorkFixture = vi.hoisted(() => ({
  now: "2026-07-01T12:00:00.000Z",
  reminderAttempts: [],
  workflowRuns: [],
  scheduledTaskFires: [],
  scheduledTaskCompletionTimeouts: [],
  subsystemFailures: [{ subsystem: "reminders", error: "reminders down" }],
}));
const reminderFixture = vi.hoisted(() => ({
  now: "2026-07-01T12:00:00.000Z",
  attempts: [{ id: "attempt-1", status: "sent" }],
}));
const processRemindersMock = vi.hoisted(() => vi.fn());
const serviceOwnerContexts = vi.hoisted(() => [] as Array<string | undefined>);
const householdFixture = vi.hoisted(() => ({
  reconcileGrantExpiryWarnings: vi.fn(async () => [
    {
      outcome: "ready" as const,
      grantId: "grant-1",
      scheduledTaskId: "task-1",
      taskState: "scheduled" as const,
      warningAt: "2026-07-02T12:00:00.000Z",
      expiresAt: "2026-07-03T12:00:00.000Z",
      deduplicated: true,
      autoExtend: false as const,
    },
  ]),
}));

vi.mock("./scheduler-task.js", () => ({
  ensureLifeOpsSchedulerTask: vi.fn(),
  ensureRuntimeAgentRecord: vi.fn(),
  isMissingLifeOpsRelationError: vi.fn(() => false),
  LIFEOPS_TASK_INTERVAL_MS: 60_000,
  LIFEOPS_TASK_JITTER_MS: 10_000,
  LIFEOPS_TASK_NAME: "LIFEOPS_SCHEDULER",
  LIFEOPS_TASK_TAGS: ["queue", "repeat", "lifeops"],
  rerunLifeOpsPluginMigrations: vi.fn(),
  resolveLifeOpsTaskIntervalMs: vi.fn(() => 60_000),
}));

vi.mock("./scheduled-task/scheduler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scheduled-task/scheduler.js")>()),
  processDueScheduledTasks: vi.fn(async () => ({
    completions: [],
    fires: [],
    completionTimeouts: [],
    pendingPrompts: [],
    errors: [],
  })),
}));

vi.mock("./app-state.js", () => ({
  loadLifeOpsAppState: vi.fn(async () => ({ enabled: true })),
}));

vi.mock("./service.js", () => ({
  LifeOpsService: class {
    constructor(_runtime: IAgentRuntime, options?: { ownerEntityId?: string }) {
      serviceOwnerContexts.push(options?.ownerEntityId);
    }

    async processReminders(options: { now?: string; limit?: number }) {
      return processRemindersMock(options);
    }

    async processScheduledWork() {
      return scheduledWorkFixture;
    }
  },
}));

vi.mock("./intent-sync.js", () => ({
  escalateUnacknowledgedIntents: vi.fn(async () => ({ escalated: 0 })),
}));

vi.mock("./household/service.js", () => ({
  createHouseholdCoordinationService: vi.fn(() => householdFixture),
  getHouseholdCoordinationService: vi.fn(() => householdFixture),
}));

vi.mock("@elizaos/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/agent")>()),
  resolveOwnerEntityId: (
    await import("../../../../packages/agent/src/runtime/owner-entity.ts")
  ).resolveOwnerEntityId,
}));

const AGENT_ID = "00000000-0000-0000-0000-0000000000ee" as UUID;
const runtime = { agentId: AGENT_ID } as unknown as IAgentRuntime;

describe("executeLifeOpsReminderTask", () => {
  it("runs only the production reminder processor with the requested bounds", async () => {
    processRemindersMock.mockResolvedValueOnce(reminderFixture);

    await expect(
      executeLifeOpsReminderTask(runtime, {
        now: "2026-07-01T12:00:00.000Z",
        limit: 7,
      }),
    ).resolves.toEqual(reminderFixture);
    expect(processRemindersMock).toHaveBeenCalledExactlyOnceWith({
      now: "2026-07-01T12:00:00.000Z",
      limit: 7,
      scope: "definitions",
    });
  });
});

describe("scheduler owner context", () => {
  it("uses the configured owner for the scheduled-work and reminder consumers", async () => {
    const ownerId = "00000000-0000-0000-0000-000000000123";
    const configuredRuntime = {
      ...runtime,
      getSetting: (key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID" ? ownerId : undefined,
    } as unknown as IAgentRuntime;
    serviceOwnerContexts.length = 0;
    processRemindersMock.mockResolvedValueOnce(reminderFixture);
    await executeLifeOpsReminderTask(configuredRuntime);
    await executeLifeOpsSchedulerTask(configuredRuntime);
    expect(serviceOwnerContexts).toEqual([ownerId, ownerId]);
  });
});

describe("registerLifeOpsTaskWorker", () => {
  it("rejects incompatible full and selective hosts before replacing the worker", () => {
    let worker: TaskWorker | undefined;
    const hostRuntime = {
      getTaskWorker: () => worker,
      registerTaskWorker: (registered: TaskWorker) => {
        worker = registered;
      },
    } as unknown as IAgentRuntime;
    registerLifeOpsTaskWorker(hostRuntime, { mode: "reminders" });
    const admitted = worker;
    expect(() => registerLifeOpsTaskWorker(hostRuntime)).toThrow(
      /either the full assistant/,
    );
    expect(worker).toBe(admitted);
  });

  it("drains admitted reminder work and rejects execution after stop", async () => {
    let worker: TaskWorker | undefined;
    const hostRuntime = {
      ...runtime,
      getTaskWorker: () => worker,
      registerTaskWorker: (registered: TaskWorker) => {
        worker = registered;
      },
      unregisterTaskWorker: () => {
        worker = undefined;
        return true;
      },
    } as unknown as IAgentRuntime;
    let finish: (result: typeof reminderFixture) => void = () => {
      throw new Error("not started");
    };
    processRemindersMock.mockClear();
    processRemindersMock.mockImplementationOnce(
      () =>
        new Promise<typeof reminderFixture>((resolve) => {
          finish = resolve;
        }),
    );
    const stop = registerLifeOpsTaskWorker(hostRuntime, { mode: "reminders" });
    const admitted = worker;
    if (!admitted) throw new Error("expected registered worker");
    const execution = admitted.execute(
      hostRuntime,
      {},
      { name: "LIFEOPS_SCHEDULER" },
    );
    await vi.waitFor(() => expect(processRemindersMock).toHaveBeenCalled());
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(
      admitted.shouldRun?.(hostRuntime, { name: "LIFEOPS_SCHEDULER" }),
    ).resolves.toBe(false);
    finish(reminderFixture);
    await execution;
    await stopping;
    expect(worker).toBeUndefined();
    await expect(
      admitted.execute(hostRuntime, {}, { name: "LIFEOPS_SCHEDULER" }),
    ).rejects.toMatchObject({ code: "LIFEOPS_SCHEDULER_INACTIVE" });
  });

  it("keeps the task identity valid without executing when scheduler is disabled", async () => {
    let registered: TaskWorker | undefined;
    const disabledRuntime = {
      getTaskWorker: () => registered,
      registerTaskWorker: (worker: TaskWorker) => {
        registered = worker;
      },
    } as unknown as IAgentRuntime;

    registerLifeOpsTaskWorker(disabledRuntime, { disabled: true });

    expect(registered?.name).toBe("LIFEOPS_SCHEDULER");
    await expect(
      registered?.shouldRun?.(disabledRuntime, {
        name: "LIFEOPS_SCHEDULER",
      }),
    ).resolves.toBe(false);
  });

  it("keeps a persisted due row out of TaskService until the claim schema is ready", async () => {
    let registered: TaskWorker | undefined;
    let ready = false;
    const task: Task = {
      id: "00000000-0000-0000-0000-0000000000ef" as UUID,
      name: "LIFEOPS_SCHEDULER",
      tags: ["queue", "repeat"],
      metadata: { updateInterval: 1, updatedAt: 0 },
    };
    const gatedRuntime = {
      agentId: AGENT_ID,
      getTaskWorker: () => registered,
      registerTaskWorker: (worker: TaskWorker) => {
        registered = worker;
      },
      getTask: vi.fn(async () => task),
      updateTask: vi.fn(async () => undefined),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as unknown as IAgentRuntime;

    registerLifeOpsTaskWorker(gatedRuntime, {
      isWorkflowClaimSchemaReady: () => ready,
    });

    const execute = vi.fn(registered?.execute);
    if (!registered) throw new Error("expected LifeOps worker registration");
    registered.execute = execute;
    const taskService = new TaskService(gatedRuntime);

    await taskService.runTick([task]);
    expect(execute).not.toHaveBeenCalled();
    await expect(
      registered?.execute(gatedRuntime, {}, { name: "LIFEOPS_SCHEDULER" }),
    ).rejects.toThrow(/claim schema is not ready/i);
    execute.mockClear();

    ready = true;
    await taskService.runTick([task]);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("executeLifeOpsSchedulerTask", () => {
  beforeEach(() => {
    vi.mocked(escalateUnacknowledgedIntents).mockReset();
    vi.mocked(escalateUnacknowledgedIntents).mockResolvedValue({
      escalated: 0,
    });
  });

  it("passes subsystemFailures through to the task result", async () => {
    const result = await executeLifeOpsSchedulerTask(runtime);
    expect(result.subsystemFailures).toEqual([
      { subsystem: "reminders", error: "reminders down" },
    ]);
    expect(result.householdGrantWarningReceipts).toEqual([
      expect.objectContaining({ outcome: "ready", grantId: "grant-1" }),
    ]);
    expect(result.nextInterval).toBe(resolveLifeOpsTaskIntervalMs(AGENT_ID));
    expect(result.now).toBe(scheduledWorkFixture.now);
  });

  it("completes the tick even when intent escalation throws", async () => {
    vi.mocked(escalateUnacknowledgedIntents).mockRejectedValue(
      new Error("escalation exploded"),
    );
    // A rethrow here would feed core's failure ladder even though the
    // scheduled work already completed — the guard must swallow + log.
    const result = await executeLifeOpsSchedulerTask(runtime);
    expect(result.now).toBe(scheduledWorkFixture.now);
    expect(result.subsystemFailures).toEqual(
      scheduledWorkFixture.subsystemFailures,
    );
  });
});
