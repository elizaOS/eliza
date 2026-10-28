import { describe, expect, it } from "vitest";
import { typedWorkflowSchedule } from "../typed-workflow-schedule";

const spec = (trigger: unknown) =>
  JSON.stringify({
    version: 1,
    name: "Morning",
    description: "",
    trigger,
    steps: [{ id: "a", kind: "Read", operation: "supplied_text", text: "x" }],
  });

describe("typed workflow schedule", () => {
  it("describes a reviewed local-time trigger and its powered-on policy", () => {
    const schedule = typedWorkflowSchedule({
      elizaPhoneWorkflowSpec: spec({
        kind: "time",
        localTime: "07:30",
        timeZone: "Europe/Paris",
        days: [1, 2, 3, 4, 5],
      }),
    });
    expect(schedule?.scheduled).toBe(true);
    expect(schedule?.summary).toMatch(
      /^Weekdays at 07:30 \(Europe\/Paris\), only while this agent is running\. A time missed while it is off is recorded as missed and never run later\./,
    );
  });

  it("states that a manual typed workflow has no schedule", () => {
    expect(
      typedWorkflowSchedule({ elizaPhoneWorkflowSpec: spec({ kind: "manual" }) }),
    ).toEqual({
      scheduled: false,
      summary: "Runs only when started explicitly. It has no schedule.",
    });
  });

  it("keeps an unreadable typed trigger manual and leaves other workflows to their triggers", () => {
    expect(
      typedWorkflowSchedule({
        elizaPhoneWorkflowSpec: spec({ kind: "cron", expression: "* * * * *" }),
      })?.scheduled,
    ).toBe(false);
    expect(typedWorkflowSchedule({ elizaPhoneWorkflowSpec: "{" })?.scheduled).toBe(
      false,
    );
    expect(typedWorkflowSchedule(undefined)).toBeNull();
    expect(typedWorkflowSchedule({ other: "value" })).toBeNull();
    expect(
      typedWorkflowSchedule({
        elizaPhoneWorkflowSpec: spec({ kind: "manual" }),
        elizaHostedDigestV1: "{}",
      }),
    ).toBeNull();
  });
});
