import { describe, expect, it } from "vitest";
import {
  actionMatchesScenarioExpectation,
  actionsAreScenarioEquivalent,
} from "./action-families.ts";

describe("action family matching", () => {
  it("matches exact and prefix-normalized action names", () => {
    expect(actionsAreScenarioEquivalent("ACTION.CALENDAR_CREATE", "calendar create")).toBe(
      true,
    );
    expect(actionsAreScenarioEquivalent("reply", "REPLY")).toBe(true);
  });

  it("matches equivalent tokenized names without overfitting separators", () => {
    expect(
      actionsAreScenarioEquivalent(
        "google_calendar.create_event",
        "calendar create event",
      ),
    ).toBe(true);
    expect(actionsAreScenarioEquivalent("SEND_EMAIL", "calendar create")).toBe(
      false,
    );
  });

  it("treats an empty expectation set as a wildcard", () => {
    expect(actionMatchesScenarioExpectation("REPLY", [])).toBe(true);
    expect(actionMatchesScenarioExpectation("REPLY", ["calendar.create"])).toBe(
      false,
    );
  });
});
