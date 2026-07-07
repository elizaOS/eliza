/**
 * Recurrence + tick-clock integration tests for `processDueScheduledTasks`
 * (#10723 recurrence-death, #10721 frozen runner clock).
 *
 * Before the fixes, every recurring ScheduledTask fired AT MOST ONCE through
 * the production tick:
 *  - terminal-death: a completed/skipped daily task fell out of the tick's
 *    `status IN ('scheduled','fired')` slice and `resolveNextFireAt` cleared
 *    its indexed `next_fire_at`, so it never reappeared;
 *  - zombie: a recurring row stuck in `fired` was IN the slice but every
 *    fire attempt raced out of the `status='scheduled'`-only claim, silently,
 *    forever;
 *  - acknowledged-death: `acknowledged` was excluded from the slice outright;
 *  - frozen clock: `ScheduledTaskRunnerService.getRunner` cached the FIRST
 *    tick's `now` closure, so every later fire stamped boot-tick time and
 *    completion timeouts became instantly due once uptime passed
 *    `followupAfterMinutes`.
 *
 * These tests drive the REAL production tick (`processDueScheduledTasks`)
 * against the repository-backed store on a real test runtime, with the tick
 * clock injected per call — exactly the wiring the W1 scheduler service-mixin
 * and the mobile `/api/background/run-due-tasks` route use.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import { LifeOpsRepository } from "../repository.ts";
import type { ScheduledTask } from "./index.ts";
import {
  type ProcessDueScheduledTasksResult,
  processDueScheduledTasks,
} from "./scheduler.ts";
import { getScheduledTaskRunner } from "./service.ts";

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
    taskId: seed.taskId ?? `st_rec_${Math.random().toString(36).slice(2, 10)}`,
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
    ...(seed.metadata ? { metadata: seed.metadata } : {}),
  };
  await repo.upsertScheduledTask(runtime.agentId, task);
  return task;
}

const dailyCronSeed = (
  overrides: Partial<ScheduledTaskSeed> = {},
): ScheduledTaskSeed => ({
  kind: "checkin",
  promptInstructions: "Daily 9am check-in.",
  trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
  priority: "medium",
  respectsGlobalPause: false,
  source: "default_pack",
  ownerVisible: true,
  // The repository stamps `metadata.createdAtIso` from the row's real
  // insert time; a cron task never fires occurrences from before it was
  // created, so pin creation into the test's (past-dated) time frame.
  metadata: { createdAtIso: "2026-05-09T00:00:00.000Z" },
  ...overrides,
});

describe("processDueScheduledTasks — recurrence across occurrences + tick clock", () => {
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

  function tick(
    runtime: RealTestRuntimeResult["runtime"],
    nowIso: string,
  ): Promise<ProcessDueScheduledTasksResult> {
    return processDueScheduledTasks({
      runtime,
      agentId: runtime.agentId,
      now: new Date(nowIso),
      limit: 10,
    });
  }

  async function firedTransitionCount(
    runtime: RealTestRuntimeResult["runtime"],
    taskId: string,
  ): Promise<number> {
    const repo = new LifeOpsRepository(runtime);
    const log = await repo.listScheduledTaskLog({
      agentId: runtime.agentId,
      taskId,
    });
    return log.filter((entry) => entry.transition === "fired").length;
  }

  it("daily cron: fires day 1, user completes, fires AGAIN on day 2", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);
    const seed = await seedScheduledTask(runtime, dailyCronSeed());

    const day1 = await tick(runtime, "2026-05-09T09:01:00.000Z");
    expect(day1.errors).toEqual([]);
    expect(day1.fires.find((f) => f.taskId === seed.taskId)?.status).toBe(
      "fired",
    );

    // User completes the day-1 occurrence through the production runner.
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date("2026-05-09T10:00:00.000Z"),
    });
    const completed = await runner.apply(seed.taskId, "complete");
    expect(completed.state.status).toBe("completed");

    // Mid-day tick: the next occurrence (05-10 09:00) is not due — no fire.
    const midDay = await tick(runtime, "2026-05-09T15:00:00.000Z");
    expect(midDay.fires.filter((f) => f.taskId === seed.taskId)).toEqual([]);

    // Day 2: the completed recurring row resurfaces and fires again.
    const day2 = await tick(runtime, "2026-05-10T09:01:00.000Z");
    expect(day2.errors).toEqual([]);
    const day2Fire = day2.fires.find((f) => f.taskId === seed.taskId);
    expect(day2Fire?.status).toBe("fired");

    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("fired");
    expect(persisted?.state.firedAt).toBe("2026-05-10T09:01:00.000Z");
    expect(persisted?.state.completedAt).toBeUndefined();
    expect(await firedTransitionCount(runtime, seed.taskId)).toBe(2);
  });

  it("zombie: a recurring task stuck in 'fired' (no completion) fires again on day 2", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const seed = await seedScheduledTask(runtime, dailyCronSeed());

    const day1 = await tick(runtime, "2026-05-09T09:01:00.000Z");
    expect(day1.fires.find((f) => f.taskId === seed.taskId)?.status).toBe(
      "fired",
    );
    const repo = new LifeOpsRepository(runtime);
    const zombie = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(zombie?.state.status).toBe("fired");

    const day2 = await tick(runtime, "2026-05-10T09:01:00.000Z");
    expect(day2.errors).toEqual([]);
    expect(day2.fires.find((f) => f.taskId === seed.taskId)?.status).toBe(
      "fired",
    );
    const refired = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(refired?.state.firedAt).toBe("2026-05-10T09:01:00.000Z");
    expect(await firedTransitionCount(runtime, seed.taskId)).toBe(2);
  });

  it("acknowledged: an acknowledged daily check-in fires again on day 2", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const seed = await seedScheduledTask(runtime, dailyCronSeed());

    await tick(runtime, "2026-05-09T09:01:00.000Z");
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date("2026-05-09T09:10:00.000Z"),
    });
    const acked = await runner.apply(seed.taskId, "acknowledge");
    expect(acked.state.status).toBe("acknowledged");

    const day2 = await tick(runtime, "2026-05-10T09:01:00.000Z");
    expect(day2.errors).toEqual([]);
    expect(day2.fires.find((f) => f.taskId === seed.taskId)?.status).toBe(
      "fired",
    );
    const repo = new LifeOpsRepository(runtime);
    const refired = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(refired?.state.acknowledgedAt).toBeUndefined();
    expect(await firedTransitionCount(runtime, seed.taskId)).toBe(2);
  });

  it("interval: fires three times across three consecutive intervals", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const seed = await seedScheduledTask(
      runtime,
      dailyCronSeed({
        promptInstructions: "Hourly hydration check.",
        trigger: { kind: "interval", everyMinutes: 60 },
      }),
    );

    for (const [i, nowIso] of [
      "2026-05-09T12:01:00.000Z",
      "2026-05-09T13:02:00.000Z",
      "2026-05-09T14:03:00.000Z",
    ].entries()) {
      const result = await tick(runtime, nowIso);
      expect(result.errors).toEqual([]);
      expect(
        result.fires.find((f) => f.taskId === seed.taskId)?.status,
        `tick ${i + 1} at ${nowIso}`,
      ).toBe("fired");
    }
    expect(await firedTransitionCount(runtime, seed.taskId)).toBe(3);
  });

  it("completed ONCE task does NOT refire", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const seed = await seedScheduledTask(
      runtime,
      dailyCronSeed({
        kind: "reminder",
        promptInstructions: "One-shot reminder.",
        trigger: { kind: "once", atIso: "2026-05-09T09:00:00.000Z" },
        source: "user_chat",
      }),
    );

    await tick(runtime, "2026-05-09T09:01:00.000Z");
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date("2026-05-09T09:30:00.000Z"),
    });
    await runner.apply(seed.taskId, "complete");

    const day2 = await tick(runtime, "2026-05-10T09:01:00.000Z");
    expect(day2.fires.filter((f) => f.taskId === seed.taskId)).toEqual([]);
    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("completed");
    expect(await firedTransitionCount(runtime, seed.taskId)).toBe(1);
  });

  it("DISMISSED recurring task does NOT refire", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const seed = await seedScheduledTask(runtime, dailyCronSeed());

    await tick(runtime, "2026-05-09T09:01:00.000Z");
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date("2026-05-09T09:30:00.000Z"),
    });
    await runner.apply(seed.taskId, "dismiss");

    const day2 = await tick(runtime, "2026-05-10T09:01:00.000Z");
    expect(day2.fires.filter((f) => f.taskId === seed.taskId)).toEqual([]);
    const repo = new LifeOpsRepository(runtime);
    const persisted = await repo.getScheduledTask(runtime.agentId, seed.taskId);
    expect(persisted?.state.status).toBe("dismissed");
    expect(await firedTransitionCount(runtime, seed.taskId)).toBe(1);
  });

  it("missed-fire catch-up: after a 3-day offline gap the daily cron fires exactly ONCE", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const seed = await seedScheduledTask(runtime, dailyCronSeed());

    await tick(runtime, "2026-05-09T09:01:00.000Z");
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
      now: () => new Date("2026-05-09T10:00:00.000Z"),
    });
    await runner.apply(seed.taskId, "complete");

    // Device offline across the 05-10, 05-11, and 05-12 09:00 occurrences.
    const catchUp = await tick(runtime, "2026-05-12T10:30:00.000Z");
    expect(catchUp.errors).toEqual([]);
    const catchUpFires = catchUp.fires.filter((f) => f.taskId === seed.taskId);
    expect(catchUpFires).toHaveLength(1);
    expect(catchUpFires[0]?.status).toBe("fired");

    // No storm: an immediately-following tick fires nothing more.
    const after = await tick(runtime, "2026-05-12T10:35:00.000Z");
    expect(after.fires.filter((f) => f.taskId === seed.taskId)).toEqual([]);
    expect(await firedTransitionCount(runtime, seed.taskId)).toBe(2);
  });

  it("tick clock is NOT frozen: the second tick's fire stamps the second tick's time and completion timeouts are not instantly due", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    // Boot tick at 12:00 fires task A — with the old cache this froze the
    // runner clock at 12:00 forever.
    const taskA = await seedScheduledTask(
      runtime,
      dailyCronSeed({
        kind: "reminder",
        promptInstructions: "Boot-tick task.",
        trigger: { kind: "once", atIso: "2026-05-09T11:59:00.000Z" },
        source: "user_chat",
      }),
    );
    const boot = await tick(runtime, "2026-05-09T12:00:00.000Z");
    expect(boot.fires.find((f) => f.taskId === taskA.taskId)?.status).toBe(
      "fired",
    );

    // Task B fires on a SUBSEQUENT tick and carries a 30-minute completion
    // timeout. Frozen clock: firedAt would be stamped 12:00 and the timeout
    // (12:30) would already be past at the 13:50 tick.
    const taskB = await seedScheduledTask(
      runtime,
      dailyCronSeed({
        kind: "reminder",
        promptInstructions: "Later-tick task with completion timeout.",
        trigger: { kind: "once", atIso: "2026-05-09T13:29:00.000Z" },
        source: "user_chat",
        completionCheck: {
          kind: "user_acknowledged",
          followupAfterMinutes: 30,
        },
      }),
    );
    const second = await tick(runtime, "2026-05-09T13:30:00.000Z");
    expect(second.errors).toEqual([]);
    expect(second.fires.find((f) => f.taskId === taskB.taskId)?.status).toBe(
      "fired",
    );
    const persistedB = await repo.getScheduledTask(
      runtime.agentId,
      taskB.taskId,
    );
    expect(persistedB?.state.firedAt).toBe("2026-05-09T13:30:00.000Z");

    // 13:50 tick: the timeout (13:30 + 30m = 14:00) must NOT be due yet.
    const beforeTimeout = await tick(runtime, "2026-05-09T13:50:00.000Z");
    expect(
      beforeTimeout.completionTimeouts.filter((t) => t.taskId === taskB.taskId),
    ).toEqual([]);
    const stillFired = await repo.getScheduledTask(
      runtime.agentId,
      taskB.taskId,
    );
    expect(stillFired?.state.status).toBe("fired");

    // 14:01 tick: the timeout (14:00) is now genuinely due. Post-#14459 a
    // `user_acknowledged` reminder does NOT terminally skip on the FIRST
    // timeout — the default no-reply ladder (maxRetries 1, cadence [60m])
    // re-nudges once before giving up (see the sibling
    // adhd-followthrough-noreply-retry-then-skip scenario). The retry is a
    // SNOOZE whose next-fire is computed off the tick's live clock
    // (14:01 + 60m = 15:01); a boot-frozen clock would have driven this off
    // 12:00 instead.
    const firstTimeout = await tick(runtime, "2026-05-09T14:01:00.000Z");
    const retry = firstTimeout.completionTimeouts.find(
      (t) => t.taskId === taskB.taskId,
    );
    expect(retry?.status).toBe("scheduled");
    expect(retry?.reason).toBe("no_reply_retry_1");
    const snoozed = await repo.getScheduledTask(runtime.agentId, taskB.taskId);
    expect(snoozed?.state.status).toBe("scheduled");
    expect(snoozed?.state.firedAt).toBe("2026-05-09T15:01:00.000Z");

    // 15:02 tick: the snooze override re-fires the reminder, and the re-fire
    // stamps THIS tick's time — the strongest anti-frozen-clock assertion, on a
    // tick well past boot. A frozen runner clock would stamp 12:00 again.
    const refire = await tick(runtime, "2026-05-09T15:02:00.000Z");
    expect(refire.errors).toEqual([]);
    expect(refire.fires.find((f) => f.taskId === taskB.taskId)?.status).toBe(
      "fired",
    );
    const refired = await repo.getScheduledTask(runtime.agentId, taskB.taskId);
    expect(refired?.state.firedAt).toBe("2026-05-09T15:02:00.000Z");

    // 15:33 tick: the re-fired occurrence's timeout (15:02 + 30m = 15:32) is
    // due and the ladder is exhausted (retryCount 1 == maxRetries 1), so the
    // reminder finally settles terminally skipped.
    const terminal = await tick(runtime, "2026-05-09T15:33:00.000Z");
    const timedOut = terminal.completionTimeouts.find(
      (t) => t.taskId === taskB.taskId,
    );
    expect(timedOut?.status).toBe("skipped");
    expect(timedOut?.reason).toBe("no_reply_reminder_expired");
    const settled = await repo.getScheduledTask(runtime.agentId, taskB.taskId);
    expect(settled?.state.status).toBe("skipped");
  });

  it("during_window: fires on two consecutive days, once per window", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const seed = await seedScheduledTask(
      runtime,
      dailyCronSeed({
        promptInstructions: "Morning stretch nudge.",
        trigger: { kind: "during_window", windowKey: "morning" },
      }),
    );

    // Default owner facts: morning window 06:00–11:00 UTC.
    const day1 = await tick(runtime, "2026-05-09T08:00:00.000Z");
    expect(day1.errors).toEqual([]);
    expect(day1.fires.find((f) => f.taskId === seed.taskId)?.status).toBe(
      "fired",
    );

    // Same window, subsequent tick: no second fire.
    const day1Later = await tick(runtime, "2026-05-09T08:30:00.000Z");
    expect(day1Later.fires.filter((f) => f.taskId === seed.taskId)).toEqual([]);

    // Next day's window: fires again.
    const day2 = await tick(runtime, "2026-05-10T08:00:00.000Z");
    expect(day2.errors).toEqual([]);
    expect(day2.fires.find((f) => f.taskId === seed.taskId)?.status).toBe(
      "fired",
    );
    expect(await firedTransitionCount(runtime, seed.taskId)).toBe(2);
  });
});
