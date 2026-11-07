/**
 * Standalone scheduler tick tests.
 *
 * Regression (sol-dev cutover QA 2026-08-11): on a runtime WITHOUT
 * plugin-personal-assistant, `POST /api/lifeops/scheduled-tasks` accepted a
 * `once` reminder (201) but nothing ever fired it — the only production
 * caller of the due-task loop lived in PA. The standalone tick is a core
 * TaskService worker, not a second timer; these tests pin:
 *
 *  - a due `once` task FIRES through the real runner (fails before the fix:
 *    no fallback driver existed, so nothing transitions the row)
 *  - a not-yet-due task does not fire
 *  - the tick defers entirely when a consumer host has registered deps
 *  - the ELIZA_DISABLE_SCHEDULING_TICK kill switch works
 *  - one throwing row does not starve the rest of the tick
 */

import {
  type IAgentRuntime,
  ServiceType,
  type Task,
  type TaskWorker,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  registerScheduledTaskRunnerDeps,
  ScheduledTaskRunnerService,
} from "./runner-service.js";
import {
  disposeStandaloneTick,
  ensureStandaloneTickTask,
  isStandaloneTickDisabled,
  registerStandaloneTickWorker,
  runStandaloneSchedulingTick,
  STANDALONE_TICK_TASK_NAME,
} from "./standalone-tick.js";

function makeFakeRuntime(): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-0000000000t1" as UUID,
    getService: (type: string) =>
      type === ServiceType.NOTIFICATION
        ? { notify: async () => undefined }
        : null,
    // Default dispatcher renders promptInstructions through the model before
    // notifying; a deterministic stub keeps fires succeeding.
    useModel: async () => "Rendered dispatch message.",
    reportError: () => undefined,
  } as unknown as IAgentRuntime;
}

/** Bind the started service into the runtime's getService lookup. */
async function startServiceOn(runtime: IAgentRuntime) {
  const service = await ScheduledTaskRunnerService.start(runtime);
  const previousGetService = runtime.getService.bind(runtime);
  (runtime as { getService: unknown }).getService = (type: string) =>
    type === ScheduledTaskRunnerService.serviceType
      ? service
      : previousGetService(type);
  return service;
}

const savedEnv = process.env.ELIZA_DISABLE_SCHEDULING_TICK;
afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.ELIZA_DISABLE_SCHEDULING_TICK;
  } else {
    process.env.ELIZA_DISABLE_SCHEDULING_TICK = savedEnv;
  }
});

describe("standalone scheduling tick", () => {
  it("fires a due `once` task that no consumer host would otherwise drive", async () => {
    const runtime = makeFakeRuntime();
    const service = await startServiceOn(runtime);

    const t0 = new Date("2026-08-11T09:40:00.000Z");
    const runner = service.getRunner({
      agentId: runtime.agentId,
      now: () => t0,
    });
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "cutover regression: fire me",
      trigger: { kind: "once", atIso: "2026-08-11T09:45:00.000Z" },
      priority: "low",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
    });
    expect(task.state.status).toBe("scheduled");

    // Before due: the tick must not fire it.
    const early = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:44:00.000Z"),
    });
    expect(early.skipped).toBeUndefined();
    expect(early.fires).toEqual([]);

    // Past due: the tick fires it through the real runner.
    const late = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:46:00.000Z"),
    });
    expect(late.errors).toEqual([]);
    expect(late.fires).toEqual([{ taskId: task.taskId, outcome: "fired" }]);

    const after = await runner.list();
    const fired = after.find((t) => t.taskId === task.taskId);
    expect(fired?.state.status).toBe("fired");
    expect(fired?.state.firedAt).toBe("2026-08-11T09:46:00.000Z");

    // Idempotent: a second tick reports the settled row as skipped, not
    // re-fired (once triggers never refire).
    const again = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:47:00.000Z"),
    });
    expect(again.fires.filter((f) => f.outcome === "fired")).toEqual([]);
  });

  it("fires an owner-local cron task in the zone saved in the plugin settings", async () => {
    const runtime = makeFakeRuntime();
    // The scheduling plugin settings field "Timezone" saves DEFAULT_TIMEZONE.
    (runtime as { getSetting: unknown }).getSetting = (key: string) =>
      key === "DEFAULT_TIMEZONE" ? "America/New_York" : undefined;
    const service = await startServiceOn(runtime);
    const runner = service.getRunner({
      agentId: runtime.agentId,
      now: () => new Date("2026-10-12T03:00:00.000Z"),
    });
    const task = await runner.schedule({
      kind: "reminder",
      promptInstructions: "8am owner-local reminder",
      trigger: { kind: "cron", expression: "0 8 * * *", tz: "owner_local" },
      priority: "low",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
      // The SQL and record stores project the row's creation time here; the
      // in-memory store does not, so set it as production rows carry it.
      metadata: { createdAtIso: "2026-10-12T03:00:00.000Z" },
    });

    // 08:00 UTC is 04:00 in New York: not the owner's 8am.
    const utcEight = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-10-12T08:00:30.000Z"),
    });
    expect(utcEight.fires).toEqual([]);

    // 12:00 UTC is 08:00 EDT.
    const ownerEight = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-10-12T12:00:30.000Z"),
    });
    expect(ownerEight.errors).toEqual([]);
    expect(ownerEight.fires).toEqual([
      { taskId: task.taskId, outcome: "fired" },
    ]);
  });

  for (const [label, trigger] of [
    [
      "interval",
      {
        kind: "interval",
        everyMinutes: 1440,
        from: "2026-10-09T09:00:00.000Z",
      },
    ],
    ["cron", { kind: "cron", expression: "0 9 * * *", tz: "UTC" }],
  ] as const) {
    it(`uses up a gate-denied ${label} occurrence at its own time, even on a late tick`, async () => {
      const runtime = makeFakeRuntime();
      const service = await startServiceOn(runtime);
      const runner = (iso: string) =>
        service.getRunner({
          agentId: runtime.agentId,
          now: () => new Date(iso),
        });
      // 2026-10-09 is a Friday: Saturday and Sunday are denied by weekend_skip.
      const task = await runner("2026-10-09T08:00:00.000Z").schedule({
        kind: "reminder",
        promptInstructions: "daily standup",
        trigger,
        shouldFire: { gates: [{ kind: "weekend_skip" }] },
        pipeline: {
          onSkip: [
            {
              taskId: "st_on_skip_template",
              kind: "reminder",
              promptInstructions: "standup skipped",
              trigger: { kind: "manual" },
              priority: "low",
              respectsGlobalPause: false,
              source: "user_chat",
              createdBy: runtime.agentId,
              ownerVisible: true,
              state: { status: "scheduled", followupCount: 0 },
            },
          ],
        },
        priority: "low",
        respectsGlobalPause: false,
        source: "user_chat",
        createdBy: runtime.agentId,
        ownerVisible: true,
        metadata: { createdAtIso: "2026-10-09T08:00:00.000Z" },
      });
      const fired: string[] = [];
      let skipped = 0;
      const start = Date.parse("2026-10-09T09:00:00.000Z");
      const end = Date.parse("2026-10-12T10:00:00.000Z");
      for (let ms = start; ms <= end; ms += 3_600_000) {
        // Saturday's ticks run five minutes late.
        const late = new Date(ms).getUTCDay() === 6 ? 5 * 60_000 : 0;
        const iso = new Date(ms + late).toISOString();
        const tick = await runStandaloneSchedulingTick(runtime, {
          now: new Date(iso),
        });
        expect(tick.errors).toEqual([]);
        for (const fire of tick.fires) {
          if (fire.taskId !== task.taskId) continue;
          if (fire.outcome === "skipped") skipped += 1;
          if (fire.outcome === "fired") {
            fired.push(iso);
            await runner(iso).apply(task.taskId, "complete", {
              reason: "done",
            });
          }
        }
      }
      expect(fired).toEqual([
        "2026-10-09T09:00:00.000Z",
        "2026-10-12T09:00:00.000Z",
      ]);
      expect(skipped).toBe(2);
      const skipChildren = (
        await runner("2026-10-12T10:00:00.000Z").list()
      ).filter((row) => row.state.pipelineParentId === task.taskId);
      expect(skipChildren).toHaveLength(2);
    });
  }

  it("uses one durable core TaskService worker row and removes it on unload", async () => {
    const workerByName = new Map<string, TaskWorker>();
    const taskById = new Map<UUID, Task>();
    let nextId = 1;
    const runtime = {
      ...makeFakeRuntime(),
      getTaskWorker: (name: string) => workerByName.get(name),
      registerTaskWorker: (worker: TaskWorker) => {
        workerByName.set(worker.name, worker);
      },
      unregisterTaskWorker: (name: string) => workerByName.delete(name),
      getTasks: async () => [...taskById.values()],
      createTask: async (task: Task) => {
        const id =
          `00000000-0000-0000-0000-${String(nextId++).padStart(12, "0")}` as UUID;
        taskById.set(id, { ...task, id });
        return id;
      },
      updateTask: async (id: UUID, update: Partial<Task>) => {
        const current = taskById.get(id);
        if (!current) throw new Error(`missing task ${id}`);
        taskById.set(id, { ...current, ...update });
      },
      deleteTask: async (id: UUID) => {
        taskById.delete(id);
      },
    } as unknown as IAgentRuntime;

    registerStandaloneTickWorker(runtime);
    registerStandaloneTickWorker(runtime);
    const firstId = await ensureStandaloneTickTask(runtime);
    const secondId = await ensureStandaloneTickTask(runtime);

    expect(secondId).toBe(firstId);
    expect([...workerByName]).toHaveLength(1);
    expect([...taskById.values()]).toMatchObject([
      {
        id: firstId,
        name: STANDALONE_TICK_TASK_NAME,
        tags: ["queue", "repeat", "scheduling"],
        metadata: { blocking: true, maxFailures: 0, paused: false },
      },
    ]);

    const worker = workerByName.get(STANDALONE_TICK_TASK_NAME);
    const driverTask = taskById.get(firstId);
    expect(driverTask).toBeDefined();
    expect(driverTask && (await worker?.shouldRun?.(runtime, driverTask))).toBe(
      true,
    );

    await disposeStandaloneTick(runtime);
    expect(workerByName.size).toBe(0);
    expect(taskById.size).toBe(0);
  });

  it("defers to a registered consumer host without touching tasks", async () => {
    const runtime = makeFakeRuntime();
    await startServiceOn(runtime);
    // Simulate PA registering its production deps provider.
    registerScheduledTaskRunnerDeps(runtime, () => {
      throw new Error("consumer deps must not be built by the standalone tick");
    });

    const result = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:46:00.000Z"),
    });
    expect(result.skipped).toBe("consumer_host");
    expect(result.fires).toEqual([]);
  });

  it("honors the ELIZA_DISABLE_SCHEDULING_TICK kill switch", async () => {
    process.env.ELIZA_DISABLE_SCHEDULING_TICK = "1";
    expect(isStandaloneTickDisabled()).toBe(true);

    const runtime = makeFakeRuntime();
    await startServiceOn(runtime);
    const result = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:46:00.000Z"),
    });
    expect(result.skipped).toBe("disabled");
    expect(result.fires).toEqual([]);
  });

  it("continues past a row whose fire throws", async () => {
    const runtime = makeFakeRuntime();
    const service = await startServiceOn(runtime);
    const t0 = new Date("2026-08-11T09:40:00.000Z");
    const runner = service.getRunner({
      agentId: runtime.agentId,
      now: () => t0,
    });

    const bad = await runner.schedule({
      kind: "reminder",
      promptInstructions: "bad row",
      trigger: { kind: "once", atIso: "2026-08-11T09:41:00.000Z" },
      priority: "low",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
    });
    const good = await runner.schedule({
      kind: "reminder",
      promptInstructions: "good row",
      trigger: { kind: "once", atIso: "2026-08-11T09:42:00.000Z" },
      priority: "low",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
    });

    // Sabotage only the bad row's fire by monkey-patching fireWithResult.
    const realFire = runner.fireWithResult.bind(runner);
    (
      runner as { fireWithResult: typeof runner.fireWithResult }
    ).fireWithResult = async (taskId, args) => {
      if (taskId === bad.taskId) throw new Error("boom");
      return realFire(taskId, args);
    };

    const result = await runStandaloneSchedulingTick(runtime, {
      now: new Date("2026-08-11T09:46:00.000Z"),
    });
    expect(result.errors).toEqual([{ taskId: bad.taskId, message: "boom" }]);
    expect(result.fires).toEqual([{ taskId: good.taskId, outcome: "fired" }]);
  });
});
