/**
 * Deterministic unit coverage for the LifeOps scheduled-task candidate
 * backstop rule: the matcher's habit/routine and recurring-cadence phrasing,
 * the past-tense fabricated-claim shape, coding-text non-matches, and the
 * owner-surface recovery targets in the declared action-name list (#17028).
 * Pure functions, no runtime or mocks.
 */

import { describe, expect, it } from "vitest";
import {
  createScheduledTaskCandidateBackstopRule,
  looksLikeScheduledTaskRequest,
} from "./candidate-backstop";

describe("looksLikeScheduledTaskRequest", () => {
  it("matches recurring-cadence commitments without a task noun (#17028)", () => {
    for (const text of [
      "25 pushups, 3 times a day, doesnt matter when i just need to get them in",
      "drink water 8 times a day",
      "call mom 2 times per week",
    ]) {
      expect(looksLikeScheduledTaskRequest(text)).toBe(true);
    }
  });

  it("matches habit/routine write phrasing", () => {
    for (const text of [
      "track this habit for me",
      "create a morning routine",
      "set up a weekly routine",
    ]) {
      expect(looksLikeScheduledTaskRequest(text)).toBe(true);
    }
  });

  it("matches the past-tense fabricated side-effect claim shape", () => {
    // core.simple_completed_side_effect_claim matches rules against the
    // fabricated REPLY text to pick recovery candidates.
    expect(
      looksLikeScheduledTaskRequest(
        "Done! I've scheduled your pushups for 9am, 2pm and 7pm.",
      ),
    ).toBe(true);
  });

  it("does not treat bare scheduled status prose as a mutation claim", () => {
    expect(
      looksLikeScheduledTaskRequest("the report was scheduled by the server"),
    ).toBe(false);
  });

  it("keeps existing reminder and time phrasing matching", () => {
    expect(looksLikeScheduledTaskRequest("remind me tomorrow at 9am")).toBe(
      true,
    );
    expect(looksLikeScheduledTaskRequest("snooze that check-in")).toBe(true);
  });

  it("does not match coding or arithmetic text", () => {
    for (const text of [
      "refactor the auth module and add unit tests",
      "whats 17 times 23?",
      "fix the build failure in ci",
      "",
    ]) {
      expect(looksLikeScheduledTaskRequest(text)).toBe(false);
    }
  });
});

describe("createScheduledTaskCandidateBackstopRule", () => {
  it("declares the owner recurring-commitment surfaces as recovery targets", () => {
    const rule = createScheduledTaskCandidateBackstopRule();
    expect(rule.actionNames).toContain("OWNER_ROUTINES");
    expect(rule.actionNames).toContain("OWNER_REMINDERS");
    expect(rule.actionNames).toContain("SCHEDULED_TASKS_CREATE");
    expect(rule.matches("25 pushups, 3 times a day")).toBe(true);
  });
});
