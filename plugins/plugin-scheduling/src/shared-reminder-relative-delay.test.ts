/** Bare end-of-command cancellations for explicit reminder delays. */
import { expect, it } from "vitest";
import { resolveExplicitSharedReminderDelay } from "./shared-reminder-relative-delay.ts";

it("treats a bare actually-don't / never / no ending as a cancellation", () => {
  for (const text of [
    "Remind me in 5 minutes, actually don't",
    "Remind me in 5 minutes, but actually don't.",
    "Remind me in 5 minutes, actually never",
    "Remind me in 5 minutes, actually no",
    "Remind me in 5 minutes, actually don't, please",
    "Remind me in 5 minutes. Actually don't.",
  ]) {
    expect(resolveExplicitSharedReminderDelay(text).kind).toBe("invalid");
  }
});

it("keeps positive idioms, revisions, and continued commands resolving", () => {
  expect(
    resolveExplicitSharedReminderDelay(
      "Remind me in 5 minutes, actually don't forget to call mom",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 300_000 });
  expect(
    resolveExplicitSharedReminderDelay(
      "Remind me in 5 minutes, actually make it 10 minutes",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 600_000 });
  expect(
    resolveExplicitSharedReminderDelay(
      "Remind me in 5 minutes, actually no, make it 10 minutes",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 300_000 });
});
