/**
 * A date written with the short month ("Oct 3", "Sept 9", "due Dec 1",
 * "3 Oct") is an explicit schedule, the same as the full month name. Before
 * this, only full month names counted, so a correction such as "I hadn't said
 * when; use Oct 3" was still read as leaving the schedule unspecified.
 */
import { describe, expect, it } from "vitest";
import {
  textExplicitlyLeavesScheduleUnspecified,
  textStatesExplicitSchedule,
} from "./extract-task-plan.ts";

describe("explicit schedule with an abbreviated month", () => {
  it.each([
    "remind me Oct 3 to pay rent",
    "remind me on Sept 9",
    "remind me on Sep 9",
    "the form is due Dec 1",
    "renew the passport by jan 15",
    "save it for Oct. 3",
    "dentist on 3 Oct",
    "book flights Nov 2nd",
  ])("reads %j as an explicit schedule", (text) => {
    expect(textStatesExplicitSchedule(text)).toBe(true);
  });

  it("still reads the full month name, as before", () => {
    expect(textStatesExplicitSchedule("remind me October 3 to pay rent")).toBe(
      true,
    );
  });

  it("does not treat a bare abbreviation without a day as a schedule", () => {
    expect(textStatesExplicitSchedule("ask jan about the report")).toBe(false);
    expect(textStatesExplicitSchedule("don't mar the finish")).toBe(false);
    expect(textStatesExplicitSchedule("water the plants")).toBe(false);
  });

  it("honours a correction that names an abbreviated date", () => {
    expect(
      textExplicitlyLeavesScheduleUnspecified("I hadn't said when; use Oct 3"),
    ).toBe(false);
    expect(
      textExplicitlyLeavesScheduleUnspecified(
        "don't make up a time, use Dec 1",
      ),
    ).toBe(false);
    // An unresolved directive with no later date is still unspecified.
    expect(
      textExplicitlyLeavesScheduleUnspecified("I haven't decided when yet"),
    ).toBe(true);
  });
});
