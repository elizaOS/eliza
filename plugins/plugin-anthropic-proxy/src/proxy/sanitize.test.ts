/**
 * Unit tests for proxy sanitization: validates applyReplacements pair mapping.
 */
import { describe, expect, it } from "vitest";
import { applyReplacements, type Pair } from "./sanitize.ts";

describe("sanitize", () => {
  it("returns original string when pair list is empty", () => {
    expect(applyReplacements("hello world", [])).toBe("hello world");
  });

  it("applies sequential replacements across string content", () => {
    const pairs: ReadonlyArray<Pair> = [
      ["alpha", "beta"],
      ["gamma", "delta"],
    ];
    const input = "alpha and gamma testing alpha";
    const output = applyReplacements(input, pairs);
    expect(output).toBe("beta and delta testing beta");
  });
});
