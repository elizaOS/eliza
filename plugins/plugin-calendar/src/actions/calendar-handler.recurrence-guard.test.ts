/**
 * Deterministic coverage for the explicit-recurrence guard on model-inferred
 * RRULEs: cadence-flavored event nouns ("standup") must not become repeating
 * events unless the user's own words state a repeating cadence.
 */
import { describe, expect, it } from "vitest";
import { intentStatesRecurrence } from "./calendar-handler.js";

describe("intentStatesRecurrence", () => {
  it("rejects one-off asks with cadence-flavored nouns", () => {
    // Live repro: the extraction model emitted RRULE:FREQ=WEEKLY;BYDAY=MO for
    // this exact ask and the built-in calendar hard-400'd on recurrence.
    expect(
      intentStatesRecurrence("add to my calendar: standup monday at 10am"),
    ).toBe(false);
    expect(intentStatesRecurrence("dentist appointment tomorrow at 3pm")).toBe(
      false,
    );
    expect(intentStatesRecurrence("lunch with sam friday")).toBe(false);
  });

  it("accepts explicit recurrence phrasings", () => {
    expect(intentStatesRecurrence("standup every monday at 10am")).toBe(true);
    expect(intentStatesRecurrence("gym weekly on wednesdays")).toBe(true);
    expect(intentStatesRecurrence("water the plants daily at 9")).toBe(true);
    expect(intentStatesRecurrence("team sync, repeats each friday")).toBe(true);
    expect(intentStatesRecurrence("recurring rent payment on the 1st")).toBe(
      true,
    );
  });

  it("is empty-safe", () => {
    expect(intentStatesRecurrence("")).toBe(false);
    expect(intentStatesRecurrence("   ")).toBe(false);
  });
});
