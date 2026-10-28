import { describe, expect, it } from "vitest";
import { workflowRunNotRun } from "../workflow-run-occurrence";

const at = "2026-10-28T07:30:00.000Z";
const iso = (value: string) => value;

describe("workflow run occurrence", () => {
  it("presents a missed scheduled occurrence as not run and offers Run now", () => {
    expect(
      workflowRunNotRun(
        {
          status: "finished",
          finished: true,
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
        output: { status: "overlap", scheduledAt: at, text: "Skipped" },
      },
      iso,
    );
    expect(result?.label).toBe("Skipped — an earlier run was still active");
    expect(result?.offerRunNow).toBe(false);
  });

  it("leaves runs that ran, unfinished runs and malformed settlements alone", () => {
    const missed = { status: "missed", scheduledAt: at, text: "Not run" };
    expect(
      workflowRunNotRun({ status: "finished", finished: true, output: "done" }),
    ).toBeNull();
    expect(
      workflowRunNotRun({ status: "running", finished: false, output: missed }),
    ).toBeNull();
    expect(
      workflowRunNotRun({ status: "failed", finished: true, output: missed }),
    ).toBeNull();
    expect(
      workflowRunNotRun({
        status: "finished",
        finished: true,
        output: { status: "missed", scheduledAt: "later", text: "x" },
      }),
    ).toBeNull();
  });
});
