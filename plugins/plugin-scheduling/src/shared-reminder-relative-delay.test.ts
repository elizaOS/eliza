/** A named "half an hour" after a whole delay is half of that unit, not an extra hour. */
import { expect, it } from "vitest";
import { resolveExplicitSharedReminderDelay } from "./shared-reminder-relative-delay.ts";

it("counts 'half an hour' once after a whole-hour delay", () => {
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in 1 hour and half an hour to call mom",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 90 * 60_000 });
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in 2 hours and half an hour to stretch",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 150 * 60_000 });
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in 1 hour and a half an hour to call mom",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 90 * 60_000 });
});

it("attributes 'half a minute' to the minute, not the previous hour", () => {
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in 1 hour and half a minute to check the oven",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 60 * 60_000 + 30_000 });
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in 30 minutes and half a minute to check the oven",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 30 * 60_000 + 30_000 });
});

it("keeps the established half forms resolving to ninety minutes", () => {
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in an hour and a half to call mom",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 90 * 60_000 });
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in 1 hour and 30 minutes to call mom",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 90 * 60_000 });
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in 1 hour and a half hour to call mom",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 90 * 60_000 });
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in 1 hour and half an hour and 15 minutes to call mom",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 105 * 60_000 });
});
