/**
 * Title matching for calendar mutation lookups when the planner's hint is
 * richer than the stored title. Pure function under test; no runtime, model,
 * or calendar service.
 */
import { describe, expect, it } from "vitest";
import { calendarTitleMatchesHint } from "./calendar-handler.js";

describe("calendarTitleMatchesHint", () => {
  it("matches a hint that folds the date and time into the title", () => {
    // Live 2026-09-05: `query` "Gym session September 8 2026 7:00" reported
    // the existing "Gym session" as not found.
    expect(
      calendarTitleMatchesHint(
        "Gym session",
        "Gym session September 8 2026 7:00",
      ),
    ).toBe(true);
  });

  it("keeps matching a hint contained in the title", () => {
    expect(calendarTitleMatchesHint("Lunch with grandma", "grandma")).toBe(
      true,
    );
  });

  it("does not match a title whose tokens are absent from the hint", () => {
    expect(calendarTitleMatchesHint("Dentist", "Gym session Tuesday 7am")).toBe(
      false,
    );
    expect(calendarTitleMatchesHint("Gym session", "gym Tuesday 7am")).toBe(
      false,
    );
  });

  it("requires whole tokens rather than substrings of the hint", () => {
    expect(calendarTitleMatchesHint("Art", "Birthday party Saturday")).toBe(
      false,
    );
  });

  it("preserves one-character title tokens", () => {
    expect(
      calendarTitleMatchesHint("Project A", "Project B September 8 2026"),
    ).toBe(false);
    expect(
      calendarTitleMatchesHint("Project A", "Project A September 8 2026"),
    ).toBe(true);
    expect(calendarTitleMatchesHint("A", "A September 8 2026")).toBe(true);
  });

  it("preserves title phrase order and requires whole short hints", () => {
    expect(
      calendarTitleMatchesHint(
        "Call before lunch",
        "Lunch before call September 8",
      ),
    ).toBe(false);
    expect(calendarTitleMatchesHint("Party", "art")).toBe(false);
    expect(calendarTitleMatchesHint("Project AB", "Project A")).toBe(false);
  });

  it("rejects empty titles and hints", () => {
    expect(calendarTitleMatchesHint("", "Gym session")).toBe(false);
    expect(calendarTitleMatchesHint("Gym session", "  ")).toBe(false);
  });
});
