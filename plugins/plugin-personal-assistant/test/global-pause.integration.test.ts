/**
 * Global pause integration tests.
 *
 * Layer 1 — `GlobalPauseStore` lifecycle: pause sets the window, `current()`
 * reflects active state inside the window, `clear()` returns to inactive.
 *
 * Layer 2 — the PRODUCTION fire path: `processDueScheduledTasks` against a
 * real PGlite-backed runtime (real `LifeOpsRepository` store, real state log,
 * the SAME `GlobalPauseStore` the runner consults). With the pause window
 * active, a due `respectsGlobalPause: true` task must be SKIPPED by the
 * runner (terminal `skipped`, `global_pause` decision log, `skipped`
 * state-log row) while a due `respectsGlobalPause: false` emergency task
 * must FIRE. An earlier version of this test re-implemented the runner's
 * pre-fire decision as a local helper and asserted the helper — it passed
 * regardless of what the production runner did. This version drives the
 * real tick, so inverting or dropping the pause check in the runner turns
 * it red.
 */

import { createGlobalPauseStore } from "@elizaos/plugin-assistant";
import { afterEach, describe, expect, it } from "vitest";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import type { ScheduledTask } from "../src/lifeops/scheduled-task/index.js";
import { processDueScheduledTasks } from "../src/lifeops/scheduled-task/scheduler.js";
import { createMinimalRuntimeStub } from "./first-run-helpers.ts";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.ts";

interface PauseTaskSeed {
  taskId: string;
  promptInstructions: string;
  trigger: ScheduledTask["trigger"];
  priority: ScheduledTask["priority"];
  respectsGlobalPause: boolean;
}

async function seedScheduledTask(
  runtime: RealTestRuntimeResult["runtime"],
  seed: PauseTaskSeed,
): Promise<ScheduledTask> {
  const repo = new LifeOpsRepository(runtime);
  const task: ScheduledTask = {
    taskId: seed.taskId,
    kind: "reminder",
    promptInstructions: seed.promptInstructions,
    trigger: seed.trigger,
    priority: seed.priority,
    respectsGlobalPause: seed.respectsGlobalPause,
    source: "user_chat",
    createdBy: runtime.agentId,
    ownerVisible: true,
    state: { status: "scheduled", followupCount: 0 },
  };
  await repo.upsertScheduledTask(runtime.agentId, task);
  return task;
}

describe("global pause integration", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("pause + current + clear lifecycle works", async () => {
    const runtime = createMinimalRuntimeStub();
    const store = createGlobalPauseStore(runtime);

    expect((await store.current()).active).toBe(false);

    const startIso = new Date(Date.now() - 60_000).toISOString();
    const endIso = new Date(Date.now() + 86_400_000).toISOString();
    await store.set({ startIso, endIso, reason: "vacation" });

    const active = await store.current();
    expect(active.active).toBe(true);
    expect(active.reason).toBe("vacation");
    expect(active.startIso).toBe(startIso);
    expect(active.endIso).toBe(endIso);

    // After endIso, no longer active.
    const afterEnd = await store.current(new Date(Date.parse(endIso) + 1));
    expect(afterEnd.active).toBe(false);

    await store.clear();
    expect((await store.current()).active).toBe(false);
  });

  it("real tick under pause: respectsGlobalPause task skips, emergency task fires", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    // Two due one-shot tasks: a routine reminder that respects the pause and
    // an emergency that must cut through it.
    const fireAt = "2026-05-09T12:00:00.000Z";
    const respecting = await seedScheduledTask(runtime, {
      taskId: "st_pause_respecting",
      promptInstructions: "Routine reminder that honors vacation mode.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: true,
    });
    const emergency = await seedScheduledTask(runtime, {
      taskId: "st_pause_emergency",
      promptInstructions: "Take the heart medication now.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "high",
      respectsGlobalPause: false,
    });

    // Engage the pause via the SAME store the production runner consults.
    const pause = createGlobalPauseStore(runtime);
    await pause.set({
      startIso: "2026-05-09T11:00:00.000Z",
      endIso: "2026-05-09T20:00:00.000Z",
      reason: "vacation",
    });
    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    expect((await pause.current(tickAt)).active).toBe(true);

    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 10,
    });
    expect(result.errors).toEqual([]);

    // The pause-respecting task was visited and skipped by the REAL runner:
    // terminal `skipped`, pause reason recorded on the decision log.
    const skipped = await repo.getScheduledTask(
      runtime.agentId,
      respecting.taskId,
    );
    expect(skipped?.state.status).toBe("skipped");
    expect(skipped?.state.lastDecisionLog).toContain("global_pause");

    // The emergency task fired straight through the active pause window.
    const fired = await repo.getScheduledTask(
      runtime.agentId,
      emergency.taskId,
    );
    expect(fired?.state.status).toBe("fired");
    expect(fired?.state.firedAt).toBeDefined();

    // State-log rows written by the real runner, not inferred by the test.
    const respectingTransitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: respecting.taskId,
      })
    ).map((entry) => entry.transition);
    expect(respectingTransitions).toContain("skipped");
    expect(respectingTransitions).not.toContain("fired");

    const emergencyTransitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: emergency.taskId,
      })
    ).map((entry) => entry.transition);
    expect(emergencyTransitions).toContain("fired");
    expect(emergencyTransitions).not.toContain("skipped");
  });

  it("a recurring task skipped by the pause does not fire that occurrence after the pause", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    // Weekly Monday 09:00 reminder, last fired the Monday before the pause.
    const weekly = await seedScheduledTask(runtime, {
      taskId: "st_pause_weekly",
      promptInstructions: "Weekly planning check-in.",
      trigger: { kind: "cron", expression: "0 9 * * 1", tz: "owner_local" },
      priority: "medium",
      respectsGlobalPause: true,
    });
    await repo.upsertScheduledTask(runtime.agentId, {
      ...weekly,
      state: {
        ...weekly.state,
        status: "fired",
        firedAt: "2026-10-05T09:00:00.000Z",
      },
    });

    const pause = createGlobalPauseStore(runtime);
    await pause.set({
      startIso: "2026-10-12T08:00:00.000Z",
      endIso: "2026-10-14T18:00:00.000Z",
      reason: "vacation",
    });

    for (const tick of [
      "2026-10-12T09:01:00.000Z",
      "2026-10-12T09:02:00.000Z",
      // After the pause, before the next Monday.
      "2026-10-14T18:01:00.000Z",
    ]) {
      const result = await processDueScheduledTasks({
        runtime,
        agentId: runtime.agentId,
        now: new Date(tick),
        limit: 10,
      });
      expect(result.errors).toEqual([]);
    }

    const transitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: weekly.taskId,
      })
    ).map((entry) => entry.transition);
    expect(transitions.filter((t) => t === "skipped")).toHaveLength(1);
    expect(transitions).not.toContain("fired");
  });

  it("an occurrence inside the pause does not fire late when no tick ran during the pause", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    const weekly = await seedScheduledTask(runtime, {
      taskId: "st_pause_weekly_offline",
      promptInstructions: "Weekly planning check-in.",
      trigger: { kind: "cron", expression: "0 9 * * 1", tz: "owner_local" },
      priority: "medium",
      respectsGlobalPause: true,
    });
    await repo.upsertScheduledTask(runtime.agentId, {
      ...weekly,
      state: {
        ...weekly.state,
        status: "fired",
        firedAt: "2026-10-05T09:00:00.000Z",
      },
    });

    const pause = createGlobalPauseStore(runtime);
    await pause.set({
      startIso: "2026-10-12T08:00:00.000Z",
      endIso: "2026-10-14T18:00:00.000Z",
      reason: "vacation",
    });

    // The scheduler was offline for the whole pause; the first tick is after it.
    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-10-14T18:01:00.000Z"),
      limit: 10,
    });
    expect(result.errors).toEqual([]);

    const transitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: weekly.taskId,
      })
    ).map((entry) => entry.transition);
    expect(transitions).toContain("skipped");
    expect(transitions).not.toContain("fired");

    // The next Monday after the pause still fires.
    await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-10-19T09:01:00.000Z"),
      limit: 10,
    });
    const after = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: weekly.taskId,
      })
    ).map((entry) => entry.transition);
    expect(after).toContain("fired");
  });

  it("a one-time task due inside an ended pause still fires after it when no tick ran during the pause", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    const once = await seedScheduledTask(runtime, {
      taskId: "st_pause_once_offline",
      promptInstructions: "Call the pharmacy.",
      trigger: { kind: "once", atIso: "2026-05-09T12:00:00.000Z" },
      priority: "medium",
      respectsGlobalPause: true,
    });
    const pause = createGlobalPauseStore(runtime);
    await pause.set({
      startIso: "2026-05-09T11:00:00.000Z",
      endIso: "2026-05-09T20:00:00.000Z",
      reason: "vacation",
    });

    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date("2026-05-09T20:01:00.000Z"),
      limit: 10,
    });
    expect(result.errors).toEqual([]);

    const fired = await repo.getScheduledTask(runtime.agentId, once.taskId);
    expect(fired?.state.status).toBe("fired");
  });

  it("a one-minute task fires again on the first tick after an ended pause when no tick ran during it", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    const minutely = await seedScheduledTask(runtime, {
      taskId: "st_pause_minutely_offline",
      promptInstructions: "Minute check.",
      trigger: { kind: "interval", everyMinutes: 1 },
      priority: "low",
      respectsGlobalPause: true,
    });
    await repo.upsertScheduledTask(runtime.agentId, {
      ...minutely,
      state: {
        ...minutely.state,
        status: "fired",
        firedAt: "2026-10-12T10:00:00.000Z",
      },
    });
    const pause = createGlobalPauseStore(runtime);
    await pause.set({
      startIso: "2026-10-12T10:00:00.000Z",
      endIso: "2026-10-12T10:30:00.000Z",
      reason: "focus",
    });

    for (const tick of [
      "2026-10-12T10:31:00.000Z",
      "2026-10-12T10:32:00.000Z",
    ]) {
      const result = await processDueScheduledTasks({
        runtime,
        agentId: runtime.agentId,
        now: new Date(tick),
        limit: 10,
      });
      expect(result.errors).toEqual([]);
    }

    const transitions = (
      await repo.listScheduledTaskLog({
        agentId: runtime.agentId,
        taskId: minutely.taskId,
      })
    ).map((entry) => entry.transition);
    expect(transitions.filter((t) => t === "skipped")).toHaveLength(1);
    expect(transitions.filter((t) => t === "fired")).toHaveLength(1);
    const task = await repo.getScheduledTask(runtime.agentId, minutely.taskId);
    expect(task?.state.status).toBe("fired");
  });
});
