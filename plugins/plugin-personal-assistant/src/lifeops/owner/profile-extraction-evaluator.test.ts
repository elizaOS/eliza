/** Verifies deterministic owner name, location, and timezone extraction from explicit free text without inferring sensitive facts from transport metadata. */

import { describe, expect, it } from "vitest";
import { extractProfileDetails } from "./profile-extraction-evaluator";

const NOW = new Date("2026-08-21T12:00:00.000Z");

describe("owner profile extraction", () => {
  it("extracts the owner's explicit name, location, and timezone together", () => {
    const result = extractProfileDetails(
      "Call me Maya. I live in Oakland, and my timezone is America/Los_Angeles.",
      NOW,
    );

    expect(result.facts).toMatchObject({
      preferredName: "Maya",
      location: "Oakland",
      timezone: "America/Los_Angeles",
    });
  });

  it("treats a later explicit correction as the new candidate value", () => {
    expect(
      extractProfileDetails("Actually, call me MJ.", NOW).facts.preferredName,
    ).toBe("MJ");
  });

  it("does not misread scheduling language or transport metadata as profile facts", () => {
    expect(
      extractProfileDetails("Call me at 5 when I land.", NOW).facts,
    ).toEqual({});
    expect(
      extractProfileDetails("I'm in a meeting until 5.", NOW).facts,
    ).toEqual({});
    expect(
      extractProfileDetails("Sent from +1 415 555 0100", NOW).facts,
    ).toEqual({});
  });
});
