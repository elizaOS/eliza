/**
 * A leading "half an hour" is half of its unit, not an absent delay. The
 * resolver only accepted "half" after a whole delay ("an hour and a half"),
 * so "remind me in half an hour" recovered no command delay and the
 * reminder fell back to the model-extracted minutes the resolver exists to
 * keep out of command-position delays — or failed outright when the model
 * extracted nothing.
 */

import { expect, it } from "vitest";
import { resolveExplicitSharedReminderDelay } from "./shared-reminder-relative-delay.ts";

it("resolves a leading half unit in the command position", () => {
  expect(
    resolveExplicitSharedReminderDelay("remind me in half an hour to call mom"),
  ).toEqual({ kind: "resolved", milliseconds: 30 * 60_000 });
  expect(
    resolveExplicitSharedReminderDelay("remind me in a half hour to call mom"),
  ).toEqual({ kind: "resolved", milliseconds: 30 * 60_000 });
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in half a minute to check the oven",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 30_000 });
  expect(
    resolveExplicitSharedReminderDelay("remind me in half a second to blink"),
  ).toEqual({ kind: "resolved", milliseconds: 500 });
});

it("resolves a leading half unit before and after the command", () => {
  expect(
    resolveExplicitSharedReminderDelay(
      "in half an hour, remind me to call mom",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 30 * 60_000 });
  expect(
    resolveExplicitSharedReminderDelay("remind me to call mom in half an hour"),
  ).toEqual({ kind: "resolved", milliseconds: 30 * 60_000 });
});

it("composes a leading half unit with a following duration", () => {
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in half an hour and 15 minutes to call mom",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 45 * 60_000 });
});

it("keeps a negated leading half delay invalid", () => {
  expect(
    resolveExplicitSharedReminderDelay(
      "don't remind me in half an hour to call mom",
    ),
  ).toEqual({
    kind: "invalid",
    reason: "A negated reminder command cannot create a reminder.",
  });
});

it("keeps the established whole and trailing-half forms resolving", () => {
  expect(
    resolveExplicitSharedReminderDelay(
      "remind me in an hour and a half to call mom",
    ),
  ).toEqual({ kind: "resolved", milliseconds: 90 * 60_000 });
  expect(
    resolveExplicitSharedReminderDelay("remind me in 30 minutes to call mom"),
  ).toEqual({ kind: "resolved", milliseconds: 30 * 60_000 });
});
