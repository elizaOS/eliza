import { describe, expect, it } from "vitest";

import {
  isCompletionTimeoutDue,
  isScheduledTaskDue,
  pendingPromptRoomIdForTask,
} from "./due.js";
import type { ScheduledTask } from "./types.js";

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    taskId: "task-1",
    kind: "reminder",
    promptInstructions: "Do the thing.",
    trigger: { kind: "manual" },
    priority: "medium",
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "user_chat",
    createdBy: "agent",
    ownerVisible: true,
    ...overrides,
  };
}

describe("ScheduledTask due evaluation", () => {
  it("fires a one-shot task once and does not refire after firedAt exists", async () => {
    const due = await isScheduledTaskDue(
      task({ trigger: { kind: "once", atIso: "2026-05-10T12:00:00.000Z" } }),
      { now: new Date("2026-05-10T12:01:00.000Z") },
    );
    expect(due).toMatchObject({ due: true, reason: "once_due" });

    const already = await isScheduledTaskDue(
      task({
        trigger: { kind: "once", atIso: "2026-05-10T12:00:00.000Z" },
        state: {
          status: "fired",
          followupCount: 0,
          firedAt: "2026-05-10T12:01:00.000Z",
        },
      }),
      { now: new Date("2026-05-10T12:02:00.000Z") },
    );
    expect(already).toMatchObject({
      due: false,
      reason: "once_already_fired",
    });
  });

  it("uses the shared cron scheduler and catches up from createdAt metadata", async () => {
    const decision = await isScheduledTaskDue(
      task({
        trigger: { kind: "cron", expression: "0 9 * * *", tz: "UTC" },
        metadata: { createdAtIso: "2026-05-10T08:00:00.000Z" },
      }),
      { now: new Date("2026-05-10T09:05:00.000Z") },
    );
    expect(decision).toMatchObject({
      due: true,
      reason: "cron_due",
      occurrenceAtIso: "2026-05-10T09:00:00.000Z",
    });
  });

  it("fires interval tasks from the last firedAt", async () => {
    const decision = await isScheduledTaskDue(
      task({
        trigger: { kind: "interval", everyMinutes: 15 },
        state: {
          status: "fired",
          followupCount: 0,
          firedAt: "2026-05-10T09:00:00.000Z",
        },
      }),
      { now: new Date("2026-05-10T09:16:00.000Z") },
    );
    expect(decision).toMatchObject({
      due: true,
      reason: "interval_due",
      occurrenceAtIso: "2026-05-10T09:15:00.000Z",
    });
  });

  it("resolves wake anchors from owner facts when no runtime resolver is present", async () => {
    const decision = await isScheduledTaskDue(
      task({
        trigger: {
          kind: "relative_to_anchor",
          anchorKey: "wake.confirmed",
          offsetMinutes: 30,
        },
      }),
      {
        now: new Date("2026-05-10T13:31:00.000Z"),
        ownerFacts: {
          timezone: "UTC",
          morningWindow: { start: "13:00", end: "16:00" },
        },
      },
    );
    expect(decision).toMatchObject({
      due: true,
      reason: "anchor_due",
      occurrenceAtIso: "2026-05-10T13:30:00.000Z",
    });
  });

  it("fires during-window tasks only once per local window key", async () => {
    const first = await isScheduledTaskDue(
      task({ trigger: { kind: "during_window", windowKey: "morning" } }),
      {
        now: new Date("2026-05-10T09:10:00.000Z"),
        ownerFacts: {
          timezone: "UTC",
          morningWindow: { start: "09:00", end: "11:00" },
        },
      },
    );
    expect(first).toMatchObject({ due: true, reason: "window_due" });

    const second = await isScheduledTaskDue(
      task({
        trigger: { kind: "during_window", windowKey: "morning" },
        metadata: { lastWindowFireKey: "2026-05-10:morning:morning" },
      }),
      {
        now: new Date("2026-05-10T09:15:00.000Z"),
        ownerFacts: {
          timezone: "UTC",
          morningWindow: { start: "09:00", end: "11:00" },
        },
      },
    );
    expect(second).toMatchObject({
      due: false,
      reason: "window_already_fired",
    });
  });

  it("detects completion timeouts and pending-prompt room targets", () => {
    const fired = task({
      completionCheck: {
        kind: "user_replied_within",
        followupAfterMinutes: 30,
      },
      output: { destination: "channel", target: "in_app:room-1" },
      state: {
        status: "fired",
        followupCount: 0,
        firedAt: "2026-05-10T09:00:00.000Z",
      },
    });
    expect(
      isCompletionTimeoutDue(fired, new Date("2026-05-10T09:31:00.000Z")),
    ).toMatchObject({
      due: true,
      reason: "completion_timeout_due",
    });
    expect(pendingPromptRoomIdForTask(fired)).toBe("room-1");
  });
});

describe("owner_local cron tz resolution", () => {
  // 2026-05-10 is inside US daylight time: America/Denver = UTC-6.
  const trigger = {
    kind: "cron",
    expression: "0 9 * * *",
    tz: "owner_local",
  } as const;

  it("is NOT due at 09:05 UTC when the owner is in America/Denver (03:05 local)", async () => {
    const decision = await isScheduledTaskDue(
      task({
        trigger,
        metadata: { createdAtIso: "2026-05-10T08:00:00.000Z" },
      }),
      {
        now: new Date("2026-05-10T09:05:00.000Z"),
        ownerFacts: { timezone: "America/Denver" },
      },
    );
    expect(decision).toMatchObject({ due: false, reason: "cron_pending" });
  });

  it("is due at the Denver hour (15:00 UTC) — not the UTC hour", async () => {
    const decision = await isScheduledTaskDue(
      task({
        trigger,
        metadata: { createdAtIso: "2026-05-10T14:00:00.000Z" },
      }),
      {
        now: new Date("2026-05-10T15:05:00.000Z"),
        ownerFacts: { timezone: "America/Denver" },
      },
    );
    expect(decision).toMatchObject({
      due: true,
      reason: "cron_due",
      occurrenceAtIso: "2026-05-10T15:00:00.000Z",
    });
  });

  it("resolves owner_local to UTC when the owner has no timezone on file", async () => {
    const decision = await isScheduledTaskDue(
      task({
        trigger,
        metadata: { createdAtIso: "2026-05-10T08:00:00.000Z" },
      }),
      { now: new Date("2026-05-10T09:05:00.000Z"), ownerFacts: {} },
    );
    expect(decision).toMatchObject({
      due: true,
      reason: "cron_due",
      occurrenceAtIso: "2026-05-10T09:00:00.000Z",
    });
  });
});
