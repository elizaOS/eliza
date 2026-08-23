/**
 * Surrogate-safe truncation for Headscale admin error body.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("headscale surrogate-safe", () => {
  it("replaces lone surrogate", () => {
    expect(toWellFormedUnicode("a\uD800b")).toBe("a\uFFFDb");
  });
  it("does not split astral at 500", () => {
    expect(
      truncateWellFormed(toWellFormedUnicode(`${"x".repeat(499)}🦊`), 500),
    ).toBe("x".repeat(499));
  });
  it("caps at 500", () => {
    expect(
      truncateWellFormed(toWellFormedUnicode("a".repeat(800)), 500).length,
    ).toBe(500);
  });
});
