/** Tests deterministic CSS color parsing, including long invalid numeric tokens. */

import { describe, expect, it } from "vitest";
import { parseRgb } from "./visual-color-parser.mjs";

describe("parseRgb", () => {
  it("parses rgb and rgba components", () => {
    expect(parseRgb("rgb(1, 2, 3)")).toEqual([1, 2, 3, 1]);
    expect(parseRgb("rgba(1.5,2,3,0.5)")).toEqual([1.5, 2, 3, 0.5]);
  });

  it("rejects a 100k-character malformed component in linear time", () => {
    expect(parseRgb(`rgb(${"0".repeat(100_000)}x,0,0)`)).toBeNull();
  });
});
