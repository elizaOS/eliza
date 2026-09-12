/**
 * Deterministic coverage for the travel-origin guard: the outer planner stamps
 * `travelOriginAddress` onto ordinary creates, and the buffer prep then fails
 * the create for want of a destination. Only the user's own words open the
 * travel path.
 */
import { describe, expect, it } from "vitest";
import { intentStatesTravel } from "./calendar-handler";

describe("intentStatesTravel", () => {
  it("rejects a plain create carrying a fabricated origin (live regression)", () => {
    // Live 2026-09-12: "add a optometrist appointment friday at 3pm to my
    // calendar" arrived with travelOriginAddress "Eliza Calendar" and the
    // turn asked the user for an address instead of creating the event.
    expect(
      intentStatesTravel(
        "Eliza Calendar",
        "add a optometrist appointment friday at 3pm to my calendar",
      ),
    ).toBe(false);
    expect(intentStatesTravel("123 Main St", "dentist tomorrow at 3pm")).toBe(
      false,
    );
    expect(intentStatesTravel(undefined, "")).toBe(false);
  });

  it("keeps travel when the user asks for it or names the departure place", () => {
    expect(
      intentStatesTravel(
        "the office",
        "add dentist at 3pm friday, I'm leaving from the office",
      ),
    ).toBe(true);
    expect(
      intentStatesTravel(
        "123 Main St",
        "book the vet at 4pm and add travel time from 123 Main St",
      ),
    ).toBe(true);
    expect(
      intentStatesTravel("home", "gym at 6, how long does it take from home?"),
    ).toBe(true);
  });
});
