/** Verifies reminder-only ambient filtering against real choice regions. */

import { describe, expect, it } from "vitest";
import {
  selectAmbientMessages,
  shouldDisplayAmbientMessage,
  withoutAmbientReminderChoices,
} from "./ambient-choice-policy";

describe("withoutAmbientReminderChoices", () => {
  it("removes reminder controls while retaining surrounding prose", () => {
    const content = [
      "Time to stretch.",
      "",
      "[CHOICE:lifeops-reminder id=reminder-123]",
      "done=Done",
      "10 minutes=Snooze 10m",
      "skip=Skip",
      "[/CHOICE]",
      "",
      "You can keep chatting here.",
    ].join("\n");

    expect(withoutAmbientReminderChoices(content)).toBe(
      "Time to stretch.\n\nYou can keep chatting here.",
    );
  });

  it.each(["first-run", "model", "boot-recovery", "plan", "approval"])(
    "preserves %s choices as functional controls",
    (scope) => {
      const content = [
        "Choose an option.",
        `[CHOICE:${scope} id=control]`,
        "yes=Continue",
        "no=Go back",
        "[/CHOICE]",
      ].join("\n");

      expect(withoutAmbientReminderChoices(content)).toBe(content);
    },
  );

  it("removes multiple reminder regions without disturbing other choices", () => {
    const content = [
      "Before",
      "[CHOICE:lifeops-reminder id=one]",
      "done=Done",
      "[/CHOICE]",
      "[CHOICE:plan id=plan]",
      "ship=Ship it",
      "[/CHOICE]",
      "[CHOICE:lifeops-reminder id=two]",
      "skip=Skip",
      "[/CHOICE]",
      "After",
    ].join("\n");

    expect(withoutAmbientReminderChoices(content)).toBe(
      [
        "Before",
        "",
        "[CHOICE:plan id=plan]",
        "ship=Ship it",
        "[/CHOICE]",
        "",
        "After",
      ].join("\n"),
    );
  });

  it("omits reminder-only turns while retaining pending, rich, and ordinary choice turns", () => {
    const reminderOnly = {
      role: "assistant",
      content: "[CHOICE:lifeops-reminder id=reminder]\ndone=Done\n[/CHOICE]",
    };
    const ordinaryChoice = {
      role: "assistant",
      content: "[CHOICE:plan]\nship=Ship it\n[/CHOICE]",
    };

    expect(shouldDisplayAmbientMessage(reminderOnly)).toBe(false);
    expect(shouldDisplayAmbientMessage(ordinaryChoice)).toBe(true);
    expect(
      shouldDisplayAmbientMessage({ role: "assistant", content: "" }),
    ).toBe(true);
    expect(
      shouldDisplayAmbientMessage({ ...reminderOnly, attachments: [{}] }),
    ).toBe(true);
    expect(
      selectAmbientMessages([
        { role: "user", content: "What next?" },
        reminderOnly,
        ordinaryChoice,
      ]),
    ).toEqual([{ role: "user", content: "What next?" }, ordinaryChoice]);
  });
});
