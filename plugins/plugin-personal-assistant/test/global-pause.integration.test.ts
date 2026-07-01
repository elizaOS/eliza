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

import { afterEach, describe, expect, it } from "vitest";
import { createGlobalPauseStore } from "../src/lifeops/global-pause/store.ts";
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
});
