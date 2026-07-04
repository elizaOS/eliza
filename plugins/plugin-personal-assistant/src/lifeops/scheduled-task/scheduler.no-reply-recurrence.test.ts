/**
 * Regression coverage: a RECURRING reminder must survive the no-reply
 * retry/terminal path with its trigger intact. The retry mechanism is the
 * snooze override (`state.firedAt` = nextRetryAt), not a trigger rewrite —
 * rewriting the trigger to `once` used to kill the recurrence permanently
 * after a single unanswered occurrence. Real repository-backed runtime.
 */
import { afterEach, describe, expect, it } from "vitest";
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

let runtimeResult: RealTestRuntimeResult | undefined;

afterEach(async () => {
  await runtimeResult?.cleanup?.();
  runtimeResult = undefined;
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

describe("processDueScheduledTasks — no-reply retry keeps recurring triggers alive", () => {
  it("daily cron reminder: retry + terminal skip on day 1, fires AGAIN on day 2", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    const cronTrigger = {
      kind: "cron",
      expression: "0 11 * * *",
      tz: "UTC",
    } as const;
    const task: ScheduledTask = {
      taskId: "st_recurring_no_reply",
      kind: "reminder",
      promptInstructions: "Take medication.",
      trigger: cronTrigger,
      priority: "high",
      respectsGlobalPause: false,
      source: "user_chat",
      createdBy: runtime.agentId,
      ownerVisible: true,
      completionCheck: { kind: "user_acknowledged", followupAfterMinutes: 30 },
      // Cron tasks never fire occurrences from before their creation; pin
      // creation into the test's past-dated time frame.
      metadata: { createdAtIso: "2026-05-08T00:00:00.000Z" },
      state: {
        status: "fired",
        followupCount: 0,
        firedAt: "2026-05-09T11:00:00.000Z",
      },
    };
    await repo.upsertScheduledTask(runtime.agentId, task);

    // Day 1, 11:31 — the unanswered fire times out into a no-reply retry.
    const retryTick = await tick(runtime, "2026-05-09T11:31:00.000Z");
    expect(retryTick.errors).toEqual([]);
    expect(retryTick.completionTimeouts).toEqual([
      {
        taskId: task.taskId,
        status: "scheduled",
        reason: "no_reply_retry_1",
        occurrenceAtIso: "2026-05-09T11:30:00.000Z",
      },
    ]);
    const retried = await repo.getScheduledTask(runtime.agentId, task.taskId);
    // THE regression assertion: the cron trigger must survive the retry.
    expect(retried?.trigger).toEqual(cronTrigger);
    // The retry is carried by the snooze override, not a trigger rewrite.
    expect(retried?.state.status).toBe("scheduled");
    expect(retried?.state.firedAt).toBe("2026-05-09T12:31:00.000Z");

    // Day 1, 12:32 — the retry fires via the scheduled override.
    const refireTick = await tick(runtime, "2026-05-09T12:32:00.000Z");
    expect(refireTick.errors).toEqual([]);
    expect(
      refireTick.fires.find((fire) => fire.taskId === task.taskId)?.status,
    ).toBe("fired");

    // Day 1, 13:02 — still no reply: terminal skip for the day.
    const terminalTick = await tick(runtime, "2026-05-09T13:02:00.000Z");
    expect(terminalTick.errors).toEqual([]);
    expect(terminalTick.completionTimeouts).toEqual([
      {
        taskId: task.taskId,
        status: "skipped",
        reason: "no_reply_reminder_expired",
        occurrenceAtIso: "2026-05-09T13:02:00.000Z",
      },
    ]);
    const skipped = await repo.getScheduledTask(runtime.agentId, task.taskId);
    expect(skipped?.state.status).toBe("skipped");
    expect(skipped?.trigger).toEqual(cronTrigger);

    // Day 2, 11:01 — the daily recurrence must fire again. With the trigger
    // rewritten to `once` this tick fired NOTHING and the reminder was dead
    // forever.
    const day2Tick = await tick(runtime, "2026-05-10T11:01:00.000Z");
    expect(day2Tick.errors).toEqual([]);
    const day2Fire = day2Tick.fires.find((fire) => fire.taskId === task.taskId);
    expect(day2Fire?.status).toBe("fired");
    expect(day2Fire?.reason).toBe("cron_due");
  });
});
