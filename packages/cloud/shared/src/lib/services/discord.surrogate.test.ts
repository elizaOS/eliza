/** Surrogate-safe discord error truncation. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("discord surrogate-safe", () => {
  it("truncates at 1000 without splitting surrogate", () => {
    const emoji = "🧪";
    const text = "a".repeat(999) + emoji + "b".repeat(10);
    const out = truncateWellFormed(toWellFormedUnicode(text), 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).not.toMatch(/\uD83E$/);
    expect(JSON.stringify(out)).not.toContain("\\u");
  });

  it("handles lone surrogate", () => {
    const lone = "error \uD800 detail";
    const well = toWellFormedUnicode(lone);
    expect(well).toContain("�");
    const out = truncateWellFormed(well, 1000);
    expect(out).toContain("�");
  });

  it("caps at 1000", () => {
    const long = "x".repeat(1500);
    expect(truncateWellFormed(toWellFormedUnicode(long), 1000).length).toBe(1000);
  });
});
