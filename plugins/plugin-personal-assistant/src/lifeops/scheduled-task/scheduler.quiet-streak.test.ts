/**
 * Quiet-streak no-reply softening (#12284 item 8), end to end on the real
 * repository-backed runtime: three consecutive ignored check-ins — driven
 * through actual scheduler ticks that also exercise the recent-task-states
 * log's production writer — step the next reminder's effective intensity one
 * notch down, observable in the persisted policy object. Contrast personas
 * (no history, streak broken by a reply, approvals) prove the softening is
 * scoped and reversible.
 */
import { EventType, type Memory } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import {
  appendScheduledTaskLogEntry,
  readScheduledTaskLog,
} from "../../providers/recent-task-states.ts";
import { resolveOwnerFactStore } from "../owner/fact-store.ts";
import { resolvePendingPromptsStore } from "../pending-prompts/store.ts";
import { LifeOpsRepository } from "../repository.ts";
import type { ScheduledTask } from "./index.ts";
import {
  type ProcessDueScheduledTasksResult,
  processDueScheduledTasks,
} from "./scheduler.ts";

type Runtime = RealTestRuntimeResult["runtime"];

let runtimeResult: RealTestRuntimeResult | undefined;

afterEach(async () => {
  await runtimeResult?.cleanup?.();
  runtimeResult = undefined;
});

function tick(
  runtime: Runtime,
  nowIso: string,
): Promise<ProcessDueScheduledTasksResult> {
  return processDueScheduledTasks({
    runtime,
    agentId: runtime.agentId,
    now: new Date(nowIso),
    limit: 10,
  });
}

interface Seed extends Omit<ScheduledTask, "taskId" | "state" | "createdBy"> {
  taskId: string;
  state?: ScheduledTask["state"];
}

async function seedTask(runtime: Runtime, seed: Seed): Promise<ScheduledTask> {
  const repo = new LifeOpsRepository(runtime);
  const task: ScheduledTask = {
    taskId: seed.taskId,
    kind: seed.kind,
    promptInstructions: seed.promptInstructions,
    trigger: seed.trigger,
    priority: seed.priority,
    respectsGlobalPause: seed.respectsGlobalPause,
    source: seed.source,
    createdBy: runtime.agentId,
    ownerVisible: seed.ownerVisible,
    state: seed.state ?? { status: "scheduled", followupCount: 0 },
    ...(seed.completionCheck ? { completionCheck: seed.completionCheck } : {}),
    ...(seed.metadata ? { metadata: seed.metadata } : {}),
  };
  await repo.upsertScheduledTask(runtime.agentId, task);
  return task;
}

/** A checkin that goes terminal `expired` on its FIRST unanswered timeout. */
function quietCheckinSeed(taskId: string, day: string): Seed {
  return {
    taskId,
    kind: "checkin",
    promptInstructions: "How are you doing today?",
    trigger: { kind: "once", atIso: `${day}T08:00:00.000Z` },
    priority: "medium",
    respectsGlobalPause: false,
    source: "default_pack",
    ownerVisible: true,
    completionCheck: { kind: "user_replied_within", followupAfterMinutes: 60 },
    metadata: {
      noReplyPolicy: {
        maxRetries: 0,
        terminalStatus: "expired",
        terminalReason: "no_reply_checkin_expired",
      },
    },
  };
}

function firedReminderSeed(
  taskId: string,
  firedAtIso: string,
  priority: ScheduledTask["priority"] = "medium",
): Seed {
  return {
    taskId,
    kind: "reminder",
    promptInstructions: "Stretch for five minutes.",
    trigger: { kind: "once", atIso: firedAtIso },
    priority,
    respectsGlobalPause: false,
    source: "user_chat",
    ownerVisible: true,
    completionCheck: { kind: "user_acknowledged", followupAfterMinutes: 30 },
    state: { status: "fired", followupCount: 0, firedAt: firedAtIso },
  };
}

/** Directly seed a 3-day ignored-checkin history into the task-states log. */
async function seedQuietHistory(runtime: Runtime): Promise<void> {
  for (const day of ["2026-05-09", "2026-05-10", "2026-05-11"]) {
    await appendScheduledTaskLogEntry(runtime, {
      taskId: `st_history_${day}`,
      kind: "checkin",
      outcome: "expired",
      recordedAt: `${day}T09:00:00.000Z`,
    });
  }
}

describe("processDueScheduledTasks — quiet streak softens the next no-reply ladder (#12284)", () => {
  it("3 ignored check-ins driven through REAL ticks soften the next reminder to fire-once", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    // Day 1 check-in is already fired and unanswered; days 2-3 fire through
    // the tick loop so the log's fired/terminal writer paths both run.
    await seedTask(runtime, {
      ...quietCheckinSeed("st_quiet_checkin_d1", "2026-05-09"),
      state: {
        status: "fired",
        followupCount: 0,
        firedAt: "2026-05-09T08:00:00.000Z",
      },
    });
    await seedTask(
      runtime,
      quietCheckinSeed("st_quiet_checkin_d2", "2026-05-10"),
    );
    await seedTask(
      runtime,
      quietCheckinSeed("st_quiet_checkin_d3", "2026-05-11"),
    );

    // Day 1: the unanswered check-in expires terminally (maxRetries 0).
    const day1 = await tick(runtime, "2026-05-09T09:01:00.000Z");
    expect(day1.errors).toEqual([]);
    expect(day1.completionTimeouts).toMatchObject([
      { taskId: "st_quiet_checkin_d1", status: "expired" },
    ]);

    // Day 2: fire, then expire unanswered.
    const day2Fire = await tick(runtime, "2026-05-10T08:01:00.000Z");
    expect(day2Fire.errors).toEqual([]);
    expect(
      day2Fire.fires.find((fire) => fire.taskId === "st_quiet_checkin_d2")
        ?.status,
    ).toBe("fired");
    const day2Timeout = await tick(runtime, "2026-05-10T09:02:00.000Z");
    expect(day2Timeout.completionTimeouts).toMatchObject([
      { taskId: "st_quiet_checkin_d2", status: "expired" },
    ]);

    // Day 3: fire, then expire unanswered — the streak reaches 3.
    const day3Fire = await tick(runtime, "2026-05-11T08:01:00.000Z");
    expect(
      day3Fire.fires.find((fire) => fire.taskId === "st_quiet_checkin_d3")
        ?.status,
    ).toBe("fired");
    const day3Timeout = await tick(runtime, "2026-05-11T09:02:00.000Z");
    expect(day3Timeout.completionTimeouts).toMatchObject([
      { taskId: "st_quiet_checkin_d3", status: "expired" },
    ]);

    // The production log writer recorded the real activity: 2 fires + 3
    // terminal expiries, in tick order.
    const log = await readScheduledTaskLog(runtime);
    expect(
      log
        .filter((entry) => entry.kind === "checkin")
        .map((entry) => entry.outcome),
    ).toEqual(["expired", "fired", "expired", "fired", "expired"]);

    // Day 4: an otherwise-normal reminder times out. Without the streak it
    // would earn a 60-minute retry; the quiet streak softens the effective
    // intensity (normal → minimal) so it settles terminally instead of
    // re-poking a silent owner.
    await seedTask(
      runtime,
      firedReminderSeed("st_quiet_reminder", "2026-05-12T08:00:00.000Z"),
    );
    const day4 = await tick(runtime, "2026-05-12T08:31:00.000Z");
    expect(day4.errors).toEqual([]);
    expect(day4.completionTimeouts).toMatchObject([
      { taskId: "st_quiet_reminder", status: "skipped" },
    ]);
    const softened = await repo.getScheduledTask(
      runtime.agentId,
      "st_quiet_reminder",
    );
    expect(softened?.state.status).toBe("skipped");
    // The softening decision is structural AND observable in the record.
    expect(softened?.metadata?.noReplyPolicy).toMatchObject({
      maxRetries: 0,
      retryCadenceMinutes: [],
    });
    expect(softened?.metadata?.noReplyState).toMatchObject({
      quietStreakSoftened: true,
      quietStreakDays: 3,
      appliedReminderIntensity: "minimal",
    });
  });

  it("contrast persona with NO quiet history keeps the normal 60-minute re-nudge", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    await seedTask(
      runtime,
      firedReminderSeed("st_active_reminder", "2026-05-12T08:00:00.000Z"),
    );
    const result = await tick(runtime, "2026-05-12T08:31:00.000Z");
    expect(result.errors).toEqual([]);
    expect(result.completionTimeouts).toMatchObject([
      {
        taskId: "st_active_reminder",
        status: "scheduled",
        reason: "no_reply_retry_1",
      },
    ]);
    const retried = await repo.getScheduledTask(
      runtime.agentId,
      "st_active_reminder",
    );
    expect(retried?.state.firedAt).toBe("2026-05-12T09:31:00.000Z");
    expect(retried?.metadata?.noReplyPolicy).toMatchObject({
      maxRetries: 1,
      retryCadenceMinutes: [60],
    });
    expect(retried?.metadata?.noReplyState).not.toMatchObject({
      quietStreakSoftened: true,
    });
  });

  it("a reply breaks the streak: expired,expired,expired,completed → no softening", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    await seedQuietHistory(runtime);
    await appendScheduledTaskLogEntry(runtime, {
      taskId: "st_history_reply",
      kind: "checkin",
      outcome: "completed",
      recordedAt: "2026-05-12T07:00:00.000Z",
    });

    await seedTask(
      runtime,
      firedReminderSeed("st_reengaged_reminder", "2026-05-12T08:00:00.000Z"),
    );
    const result = await tick(runtime, "2026-05-12T08:31:00.000Z");
    expect(result.completionTimeouts).toMatchObject([
      {
        taskId: "st_reengaged_reminder",
        status: "scheduled",
        reason: "no_reply_retry_1",
      },
    ]);
    const retried = await repo.getScheduledTask(
      runtime.agentId,
      "st_reengaged_reminder",
    );
    expect(retried?.metadata?.noReplyState).not.toMatchObject({
      quietStreakSoftened: true,
    });
  });

  it("softens an explicit `persistent` owner one notch to `normal` — same lookup, fewer nudges", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    await resolveOwnerFactStore(runtime).setReminderIntensity(
      { intensity: "persistent" },
      { source: "policy_action", recordedAt: "2026-05-08T10:00:00.000Z" },
    );
    await seedQuietHistory(runtime);
    await seedTask(
      runtime,
      firedReminderSeed(
        "st_persistent_quiet_reminder",
        "2026-05-12T08:00:00.000Z",
        "high",
      ),
    );

    const result = await tick(runtime, "2026-05-12T08:31:00.000Z");
    // Still one retry (normal), NOT the persistent two-retry ladder.
    expect(result.completionTimeouts).toMatchObject([
      {
        taskId: "st_persistent_quiet_reminder",
        status: "scheduled",
        reason: "no_reply_retry_1",
      },
    ]);
    const retried = await repo.getScheduledTask(
      runtime.agentId,
      "st_persistent_quiet_reminder",
    );
    expect(retried?.metadata?.noReplyPolicy).toMatchObject({
      maxRetries: 1,
      retryCadenceMinutes: [60],
    });
    expect(retried?.metadata?.noReplyState).toMatchObject({
      quietStreakSoftened: true,
      quietStreakDays: 3,
      appliedReminderIntensity: "normal",
    });
  });

  it("approvals are NOT softened by a quiet streak (they gate agent actions)", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const repo = new LifeOpsRepository(runtime);

    await seedQuietHistory(runtime);
    await seedTask(runtime, {
      taskId: "st_quiet_approval",
      kind: "approval",
      promptInstructions: "Approve the low-risk plan?",
      trigger: { kind: "once", atIso: "2026-05-12T08:00:00.000Z" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "user_chat",
      ownerVisible: true,
      completionCheck: { kind: "user_acknowledged", followupAfterMinutes: 30 },
      state: {
        status: "fired",
        followupCount: 0,
        firedAt: "2026-05-12T08:00:00.000Z",
      },
    });

    const result = await tick(runtime, "2026-05-12T08:31:00.000Z");
    expect(result.completionTimeouts).toMatchObject([
      {
        taskId: "st_quiet_approval",
        status: "scheduled",
        reason: "no_reply_retry_1",
      },
    ]);
    const retried = await repo.getScheduledTask(
      runtime.agentId,
      "st_quiet_approval",
    );
    // Full approval cadence preserved: 2 retries at 30/120 minutes.
    expect(retried?.metadata?.noReplyPolicy).toMatchObject({
      maxRetries: 2,
      retryCadenceMinutes: [30, 120],
    });
    expect(retried?.state.firedAt).toBe("2026-05-12T09:01:00.000Z");
    expect(retried?.metadata?.noReplyState).not.toMatchObject({
      quietStreakSoftened: true,
    });
  });

  it("an owner reply through the REAL MESSAGE_RECEIVED seam appends the streak-breaking log entry", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    const roomId = "room-quiet-streak-1";

    const repo = new LifeOpsRepository(runtime);
    const firedAtIso = new Date(Date.now() - 5 * 60_000).toISOString();
    const checkin: ScheduledTask = {
      taskId: "st_replyable_checkin",
      kind: "checkin",
      promptInstructions: "How did the afternoon go?",
      trigger: { kind: "manual" },
      priority: "medium",
      respectsGlobalPause: false,
      source: "default_pack",
      createdBy: runtime.agentId,
      ownerVisible: true,
      completionCheck: { kind: "user_replied_within" },
      metadata: { pendingPromptRoomId: roomId },
      state: { status: "fired", firedAt: firedAtIso, followupCount: 0 },
    };
    await repo.upsertScheduledTask(runtime.agentId, checkin);
    await resolvePendingPromptsStore(runtime).record({
      roomId,
      taskId: checkin.taskId,
      promptSnippet: checkin.promptInstructions,
      firedAt: firedAtIso,
      expectedReplyKind: "free_form",
    });

    await runtime.emitEvent(EventType.MESSAGE_RECEIVED, {
      message: {
        id: "msg-quiet-streak-reply",
        entityId: "owner-entity-1",
        roomId,
        agentId: runtime.agentId,
        content: { text: "pretty good actually" },
        createdAt: Date.now(),
      } as unknown as Memory,
    });

    const persisted = await repo.getScheduledTask(
      runtime.agentId,
      checkin.taskId,
    );
    expect(persisted?.state.status).toBe("completed");
    const log = await readScheduledTaskLog(runtime);
    expect(
      log.find(
        (entry) =>
          entry.taskId === checkin.taskId && entry.outcome === "completed",
      ),
    ).toBeDefined();
  });
});
