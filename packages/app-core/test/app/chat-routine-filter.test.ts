import { isRoutineCodingAgentMessage } from "@elizaos/app-core/chat";
import { describe, expect, it } from "vitest";

describe("isRoutineCodingAgentMessage", () => {
  const routine = (text: string) => ({
    source: "coding-agent" as const,
    text,
  });
  const other = (text: string) => ({ text });

  it("filters auto-approval messages", () => {
    expect(
      isRoutineCodingAgentMessage(
        routine(
          "[my-task] Approved: Accept trust prompt for working directory",
        ),
      ),
    ).toBe(true);
  });

  it("filters responded messages", () => {
    expect(
      isRoutineCodingAgentMessage(
        routine("[my-task] Responded: yes — reasoning here"),
      ),
    ).toBe(true);
  });

  it("filters sent keys messages", () => {
    expect(
      isRoutineCodingAgentMessage(routine("[my-task] Sent keys: enter, down")),
    ).toBe(true);
  });

  it("filters turn done messages", () => {
    expect(
      isRoutineCodingAgentMessage(
        routine("[my-task] Turn done, continuing: implement the feature..."),
      ),
    ).toBe(true);
  });

  it("filters idle nudge messages", () => {
    expect(
      isRoutineCodingAgentMessage(
        routine("[my-task] Idle for 3m — Nudged: are you still working?"),
      ),
    ).toBe(true);
  });

  it("keeps completion messages", () => {
    expect(
      isRoutineCodingAgentMessage(
        routine('Finished "my-task".\n\nImplemented the guestbook feature.'),
      ),
    ).toBe(false);
  });

  it("keeps all-done summary", () => {
    expect(
      isRoutineCodingAgentMessage(
        routine(
          "All 3 coding agents finished (2 completed, 1 errored). Review their work when you're ready.",
        ),
      ),
    ).toBe(false);
  });

  it("keeps escalation messages", () => {
    expect(
      isRoutineCodingAgentMessage(
        routine("[my-task] Needs your attention: tests are failing"),
      ),
    ).toBe(false);
  });

  it("keeps error messages", () => {
    expect(
      isRoutineCodingAgentMessage(
        routine('"my-task" hit an error: process exited'),
      ),
    ).toBe(false);
  });

  it("ignores non-coding-agent sources", () => {
    expect(
      isRoutineCodingAgentMessage(other("[my-task] Approved: something")),
    ).toBe(false);
  });

  it("ignores messages without source", () => {
    expect(
      isRoutineCodingAgentMessage({ text: "[my-task] Approved: something" }),
    ).toBe(false);
  });
});
