/**
 * A leap-day cron (`0 9 29 2 *`) is accepted at create time, so it must fire
 * on every Feb 29, not only when the task was created in the year before one.
 * Real `isScheduledTaskDue` and `computeNextFireAt` over core's cron scan.
 */
import { describe, expect, it } from "vitest";
import { isScheduledTaskDue } from "./due.js";
import { computeNextFireAt } from "./next-fire-at.js";

const leapDayTask = (state: Record<string, unknown>, createdAtIso?: string) =>
  ({
    taskId: "leap-day",
    kind: "reminder",
    trigger: { kind: "cron", expression: "0 9 29 2 *", tz: "UTC" },
    state,
    metadata: createdAtIso ? { createdAtIso } : {},
  }) as never;

describe("leap-day cron", () => {
  it("is due on the next Feb 29 after it last fired", async () => {
    const task = leapDayTask({
      status: "completed",
      firedAt: "2024-02-29T09:00:00.000Z",
    });
    const due = await isScheduledTaskDue(task, {
      now: new Date("2028-02-29T09:05:00.000Z"),
      ownerFacts: {},
    } as never);
    expect(due).toMatchObject({
      due: true,
      occurrenceAtIso: "2028-02-29T09:00:00.000Z",
    });
  });

  it("is due on Feb 29 when it was created more than a year before", async () => {
    const task = leapDayTask(
      { status: "scheduled" },
      "2025-06-01T00:00:00.000Z",
    );
    const due = await isScheduledTaskDue(task, {
      now: new Date("2028-02-29T09:05:00.000Z"),
      ownerFacts: {},
    } as never);
    expect(due).toMatchObject({ due: true });
  });

  it("indexes the next Feb 29 as its next fire time", async () => {
    const task = leapDayTask({
      status: "completed",
      firedAt: "2024-02-29T09:00:00.000Z",
    });
    const next = await computeNextFireAt(task, {
      now: new Date("2025-03-01T00:00:00.000Z"),
      ownerFacts: {},
    } as never);
    expect(next).toBe("2028-02-29T09:00:00.000Z");
  });
});
