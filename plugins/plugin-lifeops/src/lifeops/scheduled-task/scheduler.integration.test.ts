/**
 * Integration tests for the production `processDueScheduledTasks` wrapper.
 *
 * Today's `runner.test.ts` is a harness with injected providers — it does NOT
 * exercise the production wiring path: real `LifeOpsRepository`-backed store,
 * real `GlobalPauseStore`, real `ActivitySignalBus`, real production dispatcher
 * resolved from the live `IAgentRuntime`. This file walks `processDueScheduledTasks`
 * end-to-end against that wiring so wiring drift (e.g. silent dispatcher
 * swaps, lost log rows, mis-keyed pause cache, broken gate registration order)
 * is caught by a fast in-process test rather than a manual smoke.
 *
 * Tests are intentionally tied to the production tick wrapper at
 * `scheduler.ts:88-204` — the same path the W1 scheduler service-mixin and the
 * mobile `/api/background/run-due-tasks` route both call.
 */

import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import { createGlobalPauseStore } from "../global-pause/store.ts";
import { LifeOpsRepository } from "../repository.ts";
import { processDueScheduledTasks } from "./scheduler.ts";
import type { ScheduledTask } from "./types.ts";

interface ScheduledTaskSeed
  extends Omit<ScheduledTask, "taskId" | "state" | "createdBy"> {
  taskId?: string;
  createdBy?: string;
  state?: ScheduledTask["state"];
}

async function seedScheduledTask(
  runtime: RealTestRuntimeResult["runtime"],
  seed: ScheduledTaskSeed,
): Promise<ScheduledTask> {
  const repo = new LifeOpsRepository(runtime);
  const task: ScheduledTask = {
    taskId: seed.taskId ?? `st_test_${Math.random().toString(36).slice(2, 10)}`,
    kind: seed.kind,
    promptInstructions: seed.promptInstructions,
    trigger: seed.trigger,
    priority: seed.priority,
    respectsGlobalPause: seed.respectsGlobalPause,
    source: seed.source,
    createdBy: seed.createdBy ?? runtime.agentId,
    ownerVisible: seed.ownerVisible,
    state: seed.state ?? { status: "scheduled", followupCount: 0 },
    ...(seed.shouldFire ? { shouldFire: seed.shouldFire } : {}),
    ...(seed.completionCheck ? { completionCheck: seed.completionCheck } : {}),
    ...(seed.escalation ? { escalation: seed.escalation } : {}),
    ...(seed.output ? { output: seed.output } : {}),
    ...(seed.pipeline ? { pipeline: seed.pipeline } : {}),
    ...(seed.subject ? { subject: seed.subject } : {}),
    ...(seed.idempotencyKey ? { idempotencyKey: seed.idempotencyKey } : {}),
    ...(seed.metadata ? { metadata: seed.metadata } : {}),
  };
  await repo.upsertScheduledTask(runtime.agentId, task);
  return task;
}

describe("processDueScheduledTasks — production wiring", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  beforeEach(() => {
    runtimeResult = null;
  });

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("fires a due one-shot reminder via the real runner wired through LifeOpsRepository", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const fireAt = "2026-05-09T12:00:00.000Z";
    const seed = await seedScheduledTask(runtime, {
      kind: "reminder",
      promptInstructions: "Drink a glass of water.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: true,
      source: "user_chat",
      ownerVisible: true,
    });

    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    expect(result.fires).toHaveLength(1);
    const fired = result.fires[0];
    expect(fired?.taskId).toBe(seed.taskId);
    expect(fired?.status).toBe("fired");
    expect(fired?.reason).toBe("once_due");
    expect(fired?.occurrenceAtIso).toBe(fireAt);

    // Round-trip through the DB to confirm the production runner persisted the
    // transition (and didn't only update in-memory state).
    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");
    expect(persisted?.state.firedAt).toBeDefined();

    const log = await repo.listScheduledTaskLog({
      agentId: runtime.agentId,
      taskId: seed.taskId,
    });
    const transitions = log.map((entry) => entry.transition);
    expect(transitions).toContain("fired");
  });

  it("respectsGlobalPause via the real GlobalPauseStore: paused tasks skip, then fire after clear()", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const fireAt = "2026-05-09T12:00:00.000Z";
    const tickAt = new Date("2026-05-09T12:01:00.000Z");

    const seed = await seedScheduledTask(runtime, {
      kind: "reminder",
      promptInstructions: "Pause-respecting reminder.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: true,
      source: "user_chat",
      ownerVisible: true,
    });

    // Engage the pause via the SAME store the production runner consults.
    const pause = createGlobalPauseStore(runtime);
    await pause.set({
      startIso: "2026-05-09T11:00:00.000Z",
      endIso: "2026-05-09T20:00:00.000Z",
      reason: "vacation",
    });
    const status = await pause.current(tickAt);
    expect(status.active).toBe(true);
    expect(status.reason).toBe("vacation");

    const skippedResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });
    expect(skippedResult.errors).toEqual([]);
    expect(skippedResult.fires).toHaveLength(1);
    expect(skippedResult.fires[0]?.taskId).toBe(seed.taskId);
    // processDueScheduledTasks reports the runner's outcome regardless of
    // skipped/fired; the runner's own state is the source of truth for
    // pause-handling. Read it back and assert the skip + reason.
    const repo = new LifeOpsRepository(runtime);
    const skipped = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(skipped?.state.status).toBe("skipped");
    expect(skipped?.state.lastDecisionLog).toContain("global_pause");

    // Clear the pause; tick again; task should now fire.
    await pause.clear();
    expect((await pause.current(tickAt)).active).toBe(false);

    // The runner already saw the task as terminal (skipped); processDueScheduledTasks
    // does not refire one-shot tasks once they've transitioned out of "scheduled".
    // To prove the wiring goes through the pause check correctly when the gate
    // is open, schedule a sibling task and tick.
    const sibling = await seedScheduledTask(runtime, {
      kind: "reminder",
      promptInstructions: "Sibling reminder (post-clear).",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: true,
      source: "user_chat",
      ownerVisible: true,
    });
    const tickAfter = new Date("2026-05-09T12:02:00.000Z");
    const fireResult = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAfter,
      limit: 5,
    });
    expect(fireResult.errors).toEqual([]);
    const firedSibling = fireResult.fires.find(
      (f) => f.taskId === sibling.taskId,
    );
    expect(firedSibling?.status).toBe("fired");
    const persistedSibling = await repo.getScheduledTask(
      runtime.agentId,
      sibling.taskId,
    );
    expect(persistedSibling?.state.status).toBe("fired");
  });

  // Wave 2C owns the row-level locking that would make this safe. Today the
  // runner persists `task.state = "fired"` and only then dispatches; two
  // concurrent ticks for the same ready task BOTH read scheduled-state from
  // the DB before either writes "fired", so both call dispatch. Marking
  // skipped so this test asserts the post-2C invariant the moment the
  // single-fire SQL lock lands.
  it.skip("two parallel ticks on the same ready task fire it exactly once (Wave 2C)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const fireAt = "2026-05-09T12:00:00.000Z";
    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const seed = await seedScheduledTask(runtime, {
      kind: "reminder",
      promptInstructions: "Concurrent fire reminder.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
    });

    const [a, b] = await Promise.all([
      processDueScheduledTasks({
        runtime,
        agentId: runtime.agentId,
        now: tickAt,
        limit: 5,
      }),
      processDueScheduledTasks({
        runtime,
        agentId: runtime.agentId,
        now: tickAt,
        limit: 5,
      }),
    ]);

    const allFires = [...a.fires, ...b.fires].filter(
      (f) => f.taskId === seed.taskId,
    );
    // After Wave 2C: exactly one tick observes the task as "fired" the
    // moment it transitions; the other observes a terminal/locked row and
    // returns no fire entry. Today both tick paths see "scheduled" and
    // race-fire.
    expect(allFires).toHaveLength(1);

    const repo = new LifeOpsRepository(runtime);
    const log = await repo.listScheduledTaskLog({
      agentId: runtime.agentId,
      taskId: seed.taskId,
    });
    const fired = log.filter((entry) => entry.transition === "fired");
    expect(fired).toHaveLength(1);
  });

  it("circadian_state_in gate falls through to allow and the task fires (warn-once honest stub)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    // Spy on the logger so we can observe the gate's warning if this happens
    // to be the first time the in-process gate evaluates. Across vitest
    // workers / test ordering the warning is module-deduped, so we ALSO
    // assert the behavioral fall-through (allow → fire).
    const warnSpy = vi.spyOn(logger, "warn");

    const fireAt = "2026-05-09T12:00:00.000Z";
    const seed = await seedScheduledTask(runtime, {
      kind: "reminder",
      promptInstructions: "Circadian-gated reminder.",
      trigger: { kind: "once", atIso: fireAt },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      shouldFire: {
        compose: "first_deny",
        gates: [{ kind: "circadian_state_in", params: { in: ["awake"] } }],
      },
    });

    const tickAt = new Date("2026-05-09T12:01:00.000Z");
    const result = await processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: tickAt,
      limit: 5,
    });

    expect(result.errors).toEqual([]);
    const fired = result.fires.find((f) => f.taskId === seed.taskId);
    expect(fired?.status).toBe("fired");

    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");

    // If the warning happens to fire in this test (first eval in the worker
    // process), the spy should see the diagnostic shape. We accept either
    // outcome — the module-level deduplication is intentional. The
    // behavioral check above proves the fall-through.
    const warningCalls = warnSpy.mock.calls.filter((args) =>
      JSON.stringify(args).includes("circadian_state_in"),
    );
    if (warningCalls.length > 0) {
      const callPayload = JSON.stringify(warningCalls[0]);
      expect(callPayload).toContain("falling through to allow");
    }
    warnSpy.mockRestore();
  });
});
