/**
 * Unit tests for trigger-form-utils: validates trigger duration calculations, cron validators, and form validation.
 */
import { describe, expect, it } from "vitest";
import {
  bestFitUnit,
  durationToMs,
  emptyForm,
  humanizeEventKind,
  nextRunsForInterval,
  railMonogram,
  validateCronExpression,
  validateForm,
  validateTriggerKind,
} from "./trigger-form-utils.ts";

describe("trigger-form-utils", () => {
  it("calculates best-fit duration units and converts values to milliseconds", () => {
    expect(bestFitUnit(86_400_000)).toEqual({ value: 1, unit: "days" });
    expect(bestFitUnit(7_200_000)).toEqual({ value: 2, unit: "hours" });
    expect(bestFitUnit(120_000)).toEqual({ value: 2, unit: "minutes" });
    expect(bestFitUnit(15_000)).toEqual({ value: 15, unit: "seconds" });

    expect(durationToMs(3, "hours")).toBe(10_800_000);
    expect(durationToMs(5, "minutes")).toBe(300_000);
  });

  it("extracts rail monogram initials and humanizes event kinds", () => {
    expect(railMonogram("Daily Digest")).toBe("DD");
    expect(railMonogram("")).toBe("?");
    expect(humanizeEventKind("message.received")).toBe("Message Received");
    expect(humanizeEventKind("cron_job_fired")).toBe("Cron Job Fired");
  });

  it("validates cron expressions and computes next run intervals", () => {
    const valid = validateCronExpression("0 * * * *");
    expect(valid.ok).toBe(true);

    const invalid = validateCronExpression("invalid * cron");
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.message.length).toBeGreaterThan(0);
    }

    const fromDate = new Date("2026-01-01T00:00:00.000Z");
    const nextRuns = nextRunsForInterval(60_000, 3, fromDate);
    expect(nextRuns.length).toBe(3);
    expect(nextRuns[0].getTime()).toBe(fromDate.getTime() + 60_000);
  });

  it("validates trigger form state and target constraints", () => {
    const t = (k: string) => k;
    const invalidForm = { ...emptyForm, displayName: "" };
    expect(validateForm(invalidForm, t)).toBe(
      "triggersview.validationDisplayNameRequired",
    );

    const validForm = {
      ...emptyForm,
      displayName: "Test Trigger",
      workflowId: "wf-1",
    };
    expect(validateTriggerKind(validForm, t)).toBeNull();
    expect(validateForm(validForm, t)).toBeNull();
  });
});
