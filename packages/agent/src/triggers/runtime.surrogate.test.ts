/**
 * Surrogate truncation for trigger notifier body (200).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("trigger notifier surrogate handling", () => {
  it("199+fox at 200 backs off to 199", () => {
    const s = `${"a".repeat(199)}🦊${"b".repeat(10)}`;
    const safe = truncateWellFormed(toWellFormedUnicode(s), 200);
    expect(safe.isWellFormed()).toBe(true);
    expect(safe.length).toBe(199);
  });
  it("198+fox at 200 fits", () => {
    const s = `${"a".repeat(198)}🦊`;
    const safe = truncateWellFormed(toWellFormedUnicode(s), 200);
    expect(safe.length).toBe(200);
    expect(safe.isWellFormed()).toBe(true);
  });
  it("lone surrogates sanitized", () => {
    expect(
      truncateWellFormed(toWellFormedUnicode("\ud800"), 200).includes("�"),
    ).toBe(true);
    expect(
      truncateWellFormed(toWellFormedUnicode("\udc00"), 200).includes("�"),
    ).toBe(true);
  });
  it("short passthrough", () => {
    const s = "hello 🦊";
    expect(truncateWellFormed(toWellFormedUnicode(s), 200)).toBe(s);
  });
  it("sweep 0..30 at 200 well-formed", () => {
    for (let n = 0; n <= 30; n++) {
      const s = `${"a".repeat(n)}🦊${"b".repeat(300)}`;
      const t = truncateWellFormed(toWellFormedUnicode(s), 200);
      expect(t.isWellFormed()).toBe(true);
      expect(() => JSON.stringify(t)).not.toThrow();
    }
  });
});
