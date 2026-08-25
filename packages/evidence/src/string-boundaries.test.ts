/** Tests evidence slug boundary scanning with ordinary and adversarial runs. */

import { describe, expect, it } from "vitest";
import { trimBoundaryCharacters } from "./string-boundaries.ts";

describe("evidence string boundary scanner", () => {
  it("trims matching boundaries only", () => {
    expect(trimBoundaryCharacters("---capture-step---", "-")).toBe(
      "capture-step",
    );
  });

  it("handles 100k characters at each boundary in linear time", () => {
    const edge = "-".repeat(100_000);
    expect(trimBoundaryCharacters(`${edge}step${edge}`, "-")).toBe("step");
  });

  it("does not split unmatched Unicode code points", () => {
    const allowed = String.fromCodePoint(0x1f600);
    const sameHighSurrogate = String.fromCodePoint(0x1f601);
    const sameLowSurrogate = String.fromCodePoint(0x1f200);
    expect(
      trimBoundaryCharacters(
        `${sameHighSurrogate}step${sameLowSurrogate}`,
        allowed,
      ),
    ).toBe(`${sameHighSurrogate}step${sameLowSurrogate}`);
  });
});
