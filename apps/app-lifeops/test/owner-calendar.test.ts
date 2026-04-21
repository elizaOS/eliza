import { describe, expect, it } from "vitest";
import { inferDeterministicOwnerCalendarPlan } from "../src/actions/owner-calendar.js";

describe("OWNER_CALENDAR deterministic routing", () => {
  it("routes recurring protected time requests to recurring_block", () => {
    expect(
      inferDeterministicOwnerCalendarPlan(
        "Need to book 1 hour per day for time with Jill. Any time is fine, ideally before sleep.",
      ),
    ).toMatchObject({ subaction: "recurring_block" });
  });

  it("routes no-call hour policies to update_preferences", () => {
    expect(
      inferDeterministicOwnerCalendarPlan(
        "No calls between 11pm and 8am unless I explicitly say it's okay.",
      ),
    ).toMatchObject({ subaction: "update_preferences" });
  });

  it("routes travel bundling requests to propose_times with the travel timezone", () => {
    expect(
      inferDeterministicOwnerCalendarPlan(
        "I'm in Tokyo for limited time, so schedule PendingReality and Ryan at the same time if possible.",
      ),
    ).toMatchObject({
      subaction: "propose_times",
      parameters: { timeZone: "Asia/Tokyo" },
    });
  });

  it("routes bulk meeting pushes to bulk_reschedule", () => {
    expect(
      inferDeterministicOwnerCalendarPlan(
        "We're gonna cancel some stuff and push everything back until next month. All partnership meetings.",
      ),
    ).toMatchObject({ subaction: "bulk_reschedule" });
  });

  it("routes flight conflict requests to travel_itinerary", () => {
    expect(
      inferDeterministicOwnerCalendarPlan(
        "Flag the conflict before my flight later and help rebook the other thing.",
      ),
    ).toMatchObject({ subaction: "travel_itinerary" });
  });

  it("stands down on explicit thinking-out-loud prefacing", () => {
    expect(
      inferDeterministicOwnerCalendarPlan(
        "Do not do this yet. I'm only thinking out loud: need to book 1 hour per day for time with Jill.",
      ),
    ).toBeNull();
  });
});
