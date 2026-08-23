/**
 * Verifies surrogate-safe truncation for skill install progress messages (200).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

describe("skill install surrogate-safe truncation (200)", () => {
  it("does not split astral pair at 200", () => {
    const text = `${"a".repeat(199)}🦊${"b".repeat(10)}`;
    const truncated = truncateWellFormed(toWellFormedUnicode(text), 200);
    expect(truncated.length).toBe(199);
    expect(truncated).toBe("a".repeat(199));
  });

  it("replaces lone surrogate", () => {
    const lone = String.fromCharCode(0xd800);
    expect(truncateWellFormed(toWellFormedUnicode(lone + "x".repeat(10)), 200).includes("�")).toBe(true);
  });

  it("truncates ASCII at 200", () => {
    expect(truncateWellFormed(toWellFormedUnicode("x".repeat(300)), 200).length).toBe(200);
  });

  it("old slice splits but guard backs off", () => {
    const text = `${"a".repeat(199)}🦊`;
    const old = text.slice(0, 200);
    expect(old.charCodeAt(199)).toBe(0xd83e);
    const fixed = truncateWellFormed(toWellFormedUnicode(text), 200);
    expect(fixed.length).toBe(199);
  });
});
