import { describe, expect, it } from "vitest";
import { triggerRunMissed, workflowRunNotRun } from "../workflow-run-occurrence";

const at = "2026-10-28T07:30:00.000Z";
const iso = (value: string) => value;
const admitted = { typedSchedule: { scheduledAt: at, status: "missed" } };

describe("workflow run occurrence", () => {
  it("presents a missed scheduled occurrence as not run and offers Run now", () => {
    expect(
      workflowRunNotRun(
        {
          status: "finished",
          finished: true,
          input: admitted,
          output: { status: "missed", scheduledAt: at, text: "Not run" },
        },
        iso,
      ),
    ).toEqual({
      status: "missed",
      label: "Missed — did not run",
      notice: `Scheduled for ${at}. The agent was not running then, so nothing ran. It is not run later; use Run now to start it once.`,
      offerRunNow: true,
    });
  });

  it("offers no Run now for a missed time a manual run cannot start", () => {
    const result = workflowRunNotRun(
      {
        status: "finished",
        finished: true,
        input: { hostedDigest: { status: "missed" } },
        output: { status: "missed", scheduledAt: at, text: "Not run" },
      },
      iso,
      false,
    );
    expect(result?.offerRunNow).toBe(false);
    expect(result?.notice).toBe(
      `Scheduled for ${at}. The agent was not running then, so nothing ran. It is not run later; it runs again only at its next scheduled time.`,
    );
  });

  it("presents an overlapping occurrence as skipped without offering a run", () => {
    const result = workflowRunNotRun(
      {
        status: "finished",
        finished: true,
        input: admitted,
        output: { status: "overlap", scheduledAt: at, text: "Skipped" },
      },
      iso,
    );
    expect(result?.label).toBe("Skipped — an earlier run was still active");
    expect(result?.offerRunNow).toBe(false);
  });

  it("names the skipped local time of an occurrence the clocks moved past", () => {
    const result = workflowRunNotRun(
      {
        status: "finished",
        finished: true,
        input: admitted,
        output: {
          status: "missed",
          scheduledAt: "2026-03-08T07:30:00.000Z",
          text: "02:30 did not occur",
          skippedLocalTime: "2026-03-08T02:30",
        },
      },
      iso,
    );
    expect(result).toEqual({
      status: "missed",
      label: "Missed — did not run",
      notice:
        "Scheduled for 02:30 on 2026-03-08, a time the clocks skipped when they moved forward, so nothing ran. It is not run later; use Run now to start it once.",
      offerRunNow: true,
    });
  });

  it("leaves runs that ran, unfinished runs and malformed settlements alone", () => {
    const missed = { status: "missed", scheduledAt: at, text: "Not run" };
    const input = admitted;
    expect(
      workflowRunNotRun({
        status: "finished",
        finished: true,
        input,
        output: "done",
      }),
    ).toBeNull();
    expect(
      workflowRunNotRun({
        status: "running",
        finished: false,
        input,
        output: missed,
      }),
    ).toBeNull();
    expect(
      workflowRunNotRun({
        status: "failed",
        finished: true,
        input,
        output: missed,
      }),
    ).toBeNull();
    expect(
      workflowRunNotRun({
        status: "finished",
        finished: true,
        input,
        output: { status: "missed", scheduledAt: "later", text: "x" },
      }),
    ).toBeNull();
  });

  it("does not read a workflow's own result of the same shape as a not-run occurrence", () => {
    const missed = { status: "missed", scheduledAt: at, text: "Not run" };
    for (const input of [{}, { typedSchedule: "x" }, { hostedDigest: null }])
      expect(
        workflowRunNotRun({
          status: "finished",
          finished: true,
          input,
          output: missed,
        }),
      ).toBeNull();
  });

  it("presents a generic schedule's engine-recorded missed occurrence as not run", () => {
    const missed = { status: "missed", scheduledAt: at, text: "Not run" };
    expect(
      workflowRunNotRun(
        {
          status: "finished",
          finished: true,
          input: {},
          output: missed,
          missedOccurrenceAt: at,
        },
        iso,
      )?.status,
    ).toBe("missed");
    // Without a valid engine marker, or on an overlap output, the shape alone is not trusted.
    for (const over of [
      { missedOccurrenceAt: "soon" },
      { output: { ...missed, status: "overlap" }, missedOccurrenceAt: at },
    ])
      expect(
        workflowRunNotRun({
          status: "finished",
          finished: true,
          input: {},
          output: missed,
          ...over,
        }),
      ).toBeNull();
  });
});

describe("trigger run missed occurrence", () => {
  const at = Date.parse("2026-10-12T09:00:00.000Z");
  const fmt = (epochMs: number) => new Date(epochMs).toISOString();

  it("presents a skipped run with a recorded missed occurrence as not run", () => {
    expect(
      triggerRunMissed({ status: "skipped", missedOccurrenceAt: at }, fmt),
    ).toEqual({
      label: "Missed — did not run",
      notice:
        "Scheduled for 2026-10-12T09:00:00.000Z. The agent was not running then, so nothing ran. It is not run later; it runs again at its next scheduled time.",
    });
  });

  it("keeps the generic presentation for any other run", () => {
    expect(triggerRunMissed({ status: "skipped" }, fmt)).toBeNull();
    expect(
      triggerRunMissed({ status: "success", missedOccurrenceAt: at }, fmt),
    ).toBeNull();
    expect(
      triggerRunMissed({ status: "skipped", missedOccurrenceAt: "soon" }, fmt),
    ).toBeNull();
    expect(
      triggerRunMissed({ status: "skipped", missedOccurrenceAt: 0 }, fmt),
    ).toBeNull();
  });
});
