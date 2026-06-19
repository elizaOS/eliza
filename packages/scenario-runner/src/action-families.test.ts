import { describe, expect, it } from "vitest";
import {
  actionMatchesScenarioExpectation,
  actionsAreScenarioEquivalent,
} from "./action-families.ts";

describe("action family matching", () => {
  it("matches exact and prefix-normalized action names", () => {
    expect(
      actionsAreScenarioEquivalent("ACTION.CALENDAR_CREATE", "calendar create"),
    ).toBe(true);
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

  it("credits parent/sub-action families on a real token boundary", () => {
    // Sub-action is more specific than the expected parent family.
    expect(
      actionsAreScenarioEquivalent("CALENDAR_CREATE_EVENT", "CALENDAR_CREATE"),
    ).toBe(true);
    // Parent family standing in for a sub-action (the original bounded behavior).
    expect(actionsAreScenarioEquivalent("SEND", "SEND_EMAIL")).toBe(true);
    expect(actionsAreScenarioEquivalent("INBOX", "INBOX_TRIAGE")).toBe(true);
    // Provider-qualified candidate matches the bare expectation.
    expect(
      actionsAreScenarioEquivalent(
        "GOOGLE_CALENDAR_CREATE_EVENT",
        "CALENDAR_CREATE_EVENT",
      ),
    ).toBe(true);
  });

  it("does NOT treat a generic action as satisfying a specific expectation", () => {
    // Separator-stripped substring over-match (the regression): these share a
    // character prefix/substring but not a leading token boundary.
    expect(actionsAreScenarioEquivalent("LIFE", "LIFEOPS")).toBe(false);
    expect(actionsAreScenarioEquivalent("LIFE", "MANAGE_LIFEOPS_BROWSER")).toBe(
      false,
    );
    expect(actionsAreScenarioEquivalent("MESSAGE", "READ_MESSAGES")).toBe(
      false,
    );
    // A bare action name must not match a specific action via an unbounded
    // suffix/subset.
    expect(actionsAreScenarioEquivalent("EMAIL", "SEND_EMAIL")).toBe(false);
    expect(actionsAreScenarioEquivalent("SEND_EMAIL", "EMAIL")).toBe(false);
    expect(
      actionsAreScenarioEquivalent("MANAGE_LIFEOPS_BROWSER", "BROWSER"),
    ).toBe(false);
    expect(
      actionsAreScenarioEquivalent("GOOGLE_CALENDAR_CREATE_EVENT", "EVENT"),
    ).toBe(false);
  });
});
