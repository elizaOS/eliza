import { describe, expect, it } from "bun:test";

import { parseSelfControlBlockRequest } from "./engine.ts";

function parseDurationMinutes(durationMinutes: string | number | null) {
  return parseSelfControlBlockRequest({
    parameters: { websites: ["x.com"], durationMinutes } as never,
  });
}

describe("website-block duration strings", () => {
  // The field is durationMinutes. Reading the leading number of a duration in
  // another unit gave a block of the wrong length with no error: "2 hours"
  // became 2 minutes, and "30 seconds" became 30 minutes.
  it("rejects a duration that states a unit other than minutes", () => {
    for (const duration of [
      "2 hours",
      "2h",
      "1 hour",
      "30 seconds",
      "2 days",
    ]) {
      const parsed = parseDurationMinutes(duration);
      expect(parsed.request).toBeNull();
      expect(parsed.error).toContain("minutes");
    }
  });

  it("keeps a bare number and a minutes unit in minutes", () => {
    expect(parseDurationMinutes("90 minutes").request?.durationMinutes).toBe(
      90,
    );
    expect(parseDurationMinutes("90m").request?.durationMinutes).toBe(90);
    expect(parseDurationMinutes("45").request?.durationMinutes).toBe(45);
    expect(parseDurationMinutes(90).request?.durationMinutes).toBe(90);
  });

  it("keeps mixed-case minutes spelling", () => {
    // The unit is matched against the lowercased value, so the spelling of the
    // unit does not change the duration.
    expect(parseDurationMinutes("90 Minutes").request?.durationMinutes).toBe(
      90,
    );
    expect(parseDurationMinutes("5 Min").request?.durationMinutes).toBe(5);
    expect(parseDurationMinutes("5M").request?.durationMinutes).toBe(5);
    expect(parseDurationMinutes("90MIN").request?.durationMinutes).toBe(90);
  });

  it("rejects a number that only looks like a duration", () => {
    // These stopped parsing with the unit check. That is the safe direction:
    // a rejected request asks the caller again instead of guessing a length.
    for (const duration of ["1e2", "+90", "-5"]) {
      const parsed = parseDurationMinutes(duration);
      expect(parsed.request).toBeNull();
      expect(parsed.error).toContain("minutes");
    }
  });

  it("keeps the manual-block tokens", () => {
    for (const token of ["manual", "indefinite", "until-unblocked"]) {
      expect(parseDurationMinutes(token).request?.durationMinutes).toBeNull();
    }
  });
});
