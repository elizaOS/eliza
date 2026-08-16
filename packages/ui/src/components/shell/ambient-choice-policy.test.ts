/** Verifies the shared ambient-chat choice policy with real parser regions. */

import { describe, expect, it } from "vitest";
import { withoutAmbientChoices } from "./ambient-choice-policy";

describe("withoutAmbientChoices", () => {
  it("removes ordinary reminder controls while retaining surrounding prose", () => {
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

    expect(withoutAmbientChoices(content)).toBe(
      "Time to stretch.\n\nYou can keep chatting here.",
    );
  });

  it("preserves first-run choices because they are required setup controls", () => {
    const content = [
      "Choose where Eliza should run.",
      "[CHOICE:first-run id=runtime]",
      "cloud=Eliza Cloud",
      "local=On device",
      "[/CHOICE]",
    ].join("\n");

    expect(withoutAmbientChoices(content)).toBe(content);
  });

  it("removes multiple ambient choice regions without disturbing plain text", () => {
    const content = [
      "Before",
      "[CHOICE:one]",
      "a=A",
      "[/CHOICE]",
      "Middle",
      "[CHOICE:two]",
      "b=B",
      "[/CHOICE]",
      "After",
    ].join("\n");

    expect(withoutAmbientChoices(content)).toBe("Before\n\nMiddle\n\nAfter");
  });
});
