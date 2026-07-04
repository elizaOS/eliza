/**
 * Pure-transform coverage for reminder-intensity → no-reply ladder (#12284 D3).
 * No runtime graph: exercises `applyReminderIntensityToNoReplyPolicy` directly.
 */
import { describe, expect, it } from "vitest";
import {
  applyReminderIntensityToNoReplyPolicy,
  type NoReplyLadder,
} from "./no-reply-intensity.ts";

const base: NoReplyLadder = { maxRetries: 1, retryCadenceMinutes: [60] };

describe("applyReminderIntensityToNoReplyPolicy", () => {
  it("normal / unset leaves the ladder unchanged", () => {
    expect(
      applyReminderIntensityToNoReplyPolicy(base, undefined, "high"),
    ).toEqual(base);
    expect(
      applyReminderIntensityToNoReplyPolicy(base, "normal", "high"),
    ).toEqual(base);
  });

  it("minimal drops every retry (fire once)", () => {
    expect(
      applyReminderIntensityToNoReplyPolicy(base, "minimal", "high"),
    ).toEqual({ maxRetries: 0, retryCadenceMinutes: [] });
  });

  it("persistent appends one nudge at the trailing cadence", () => {
    expect(
      applyReminderIntensityToNoReplyPolicy(base, "persistent", "high"),
    ).toEqual({ maxRetries: 2, retryCadenceMinutes: [60, 60] });
    // Two-step base → three steps, trailing cadence reused.
    expect(
      applyReminderIntensityToNoReplyPolicy(
        { maxRetries: 2, retryCadenceMinutes: [30, 120] },
        "persistent",
        "medium",
      ),
    ).toEqual({ maxRetries: 3, retryCadenceMinutes: [30, 120, 120] });
  });

  it("persistent on an empty ladder falls back to a 60m nudge", () => {
    expect(
      applyReminderIntensityToNoReplyPolicy(
        { maxRetries: 0, retryCadenceMinutes: [] },
        "persistent",
        "high",
      ),
    ).toEqual({ maxRetries: 1, retryCadenceMinutes: [60] });
  });

  it("high_priority_only suppresses non-high tasks but keeps high ones", () => {
    expect(
      applyReminderIntensityToNoReplyPolicy(
        base,
        "high_priority_only",
        "medium",
      ),
    ).toEqual({ maxRetries: 0, retryCadenceMinutes: [] });
    expect(
      applyReminderIntensityToNoReplyPolicy(base, "high_priority_only", "low"),
    ).toEqual({ maxRetries: 0, retryCadenceMinutes: [] });
    expect(
      applyReminderIntensityToNoReplyPolicy(base, "high_priority_only", "high"),
    ).toEqual(base);
  });

  it("preserves the other policy fields it does not own", () => {
    const rich = {
      maxRetries: 1,
      retryCadenceMinutes: [60],
      terminalStatus: "skipped" as const,
      sensitive: true,
    };
    expect(
      applyReminderIntensityToNoReplyPolicy(rich, "minimal", "high"),
    ).toMatchObject({ terminalStatus: "skipped", sensitive: true });
  });
});
