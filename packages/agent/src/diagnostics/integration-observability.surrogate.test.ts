/**
 * Surrogate truncation for integration observability sanitizeToken (1024).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("integration-observability surrogate handling", () => {
  it("1023+fox at 1024 backs off to 1023", () => {
    const s = `${"a".repeat(1023)}🦊${"b".repeat(10)}`;
    const safe = truncateWellFormed(toWellFormedUnicode(s), 1024);
    expect(safe.isWellFormed()).toBe(true);
    expect(safe.length).toBe(1023);
  });
  it("1022+fox at 1024 fits", () => {
    const s = `${"a".repeat(1022)}🦊`;
    const safe = truncateWellFormed(toWellFormedUnicode(s), 1024);
    expect(safe.length).toBe(1024);
    expect(safe.isWellFormed()).toBe(true);
  });
  it("lone surrogates sanitized", () => {
    expect(
      truncateWellFormed(toWellFormedUnicode("\ud800"), 1024).isWellFormed(),
    ).toBe(true);
    expect(
      truncateWellFormed(toWellFormedUnicode("\udc00"), 1024).isWellFormed(),
    ).toBe(true);
  });
  it("sweep 0..30 at 1024 well-formed", () => {
    for (let n = 0; n <= 30; n++) {
      const s = `${"a".repeat(n)}🦊${"b".repeat(2000)}`;
      const t = truncateWellFormed(toWellFormedUnicode(s), 1024);
      expect(t.isWellFormed()).toBe(true);
      expect(t.length).toBeLessThanOrEqual(1024);
      expect(() => JSON.stringify(t)).not.toThrow();
    }
  });
  it("short passthrough", () => {
    expect(truncateWellFormed(toWellFormedUnicode("hello"), 1024)).toBe(
      "hello",
    );
  });
});
