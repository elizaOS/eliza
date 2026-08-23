/** Surrogate-safe truncateWellFormed in api-client. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("api-client surrogate-safe", () => {
  it("does not split surrogate pair at 500", () => {
    const emoji = "😀";
    const text = "a".repeat(499) + emoji + "b".repeat(10);
    const truncated = truncateWellFormed(toWellFormedUnicode(text), 500);
    expect(truncated.length).toBeLessThanOrEqual(500);
    expect(truncated).not.toMatch(/\uD83D$/);
    expect(() => JSON.stringify(truncated)).not.toThrow();
  });

  it("replaces lone surrogate", () => {
    const lone = "\uD800 hello";
    const well = toWellFormedUnicode(lone);
    expect(well).not.toContain("\uD800");
    expect(well).toContain("�");
  });

  it("cap at 500", () => {
    const long = "x".repeat(600);
    const out = truncateWellFormed(toWellFormedUnicode(long), 500);
    expect(out.length).toBe(500);
  });
});
