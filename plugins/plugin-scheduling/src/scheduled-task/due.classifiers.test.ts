/**
 * Locks the two structural ScheduledTask classifiers — `isRecurringTrigger` and
 * `expectedReplyKindForTask` — so a new trigger/completion kind can't silently
 * change recurrence or expected-reply routing. Pure functions, no runtime.
 */

import { describe, expect, it } from "vitest";
import { expectedReplyKindForTask, isRecurringTrigger } from "./due.js";
import type { ScheduledTask, ScheduledTaskTrigger } from "./types.js";

// #8795 — the scheduled-task spine routes purely on structural fields. These two
// classifiers decide recurrence + the expected reply shape; lock them so a new
// trigger/completion kind can't silently fall through.
const trig = (kind: string) => ({ kind }) as unknown as ScheduledTaskTrigger;
const task = (o: Record<string, unknown>) => o as unknown as ScheduledTask;

describe("isRecurringTrigger", () => {
  it("is true for the four recurring trigger kinds", () => {
    for (const k of [
      "cron",
      "interval",
      "relative_to_anchor",
      "during_window",
    ]) {
      expect(isRecurringTrigger(trig(k))).toBe(true);
    }
  });

  it("is false for a one-shot ('once') trigger", () => {
    expect(isRecurringTrigger(trig("once"))).toBe(false);
  });
});

describe("expectedReplyKindForTask", () => {
  it("returns 'approval' for an approval task OR an approval completion check", () => {
    expect(expectedReplyKindForTask(task({ kind: "approval" }))).toBe(
      "approval",
    );
    expect(
      expectedReplyKindForTask(
        task({ kind: "reminder", completionCheck: { kind: "approval" } }),
      ),
    ).toBe("approval");
  });

  it("returns 'yes_no' for a user_acknowledged completion check", () => {
    expect(
      expectedReplyKindForTask(
        task({
          kind: "reminder",
          completionCheck: { kind: "user_acknowledged" },
        }),
      ),
    ).toBe("yes_no");
  });

  it("falls back to 'free_form' for an ordinary task", () => {
    expect(expectedReplyKindForTask(task({ kind: "reminder" }))).toBe(
      "free_form",
    );
  });
});
