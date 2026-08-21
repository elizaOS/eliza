/**
 * Surrogate-safe truncation for owner-send-policy previews (237/197 caps).
 * Verifies caps never split an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function preview237(body: string): string {
  const wellFormed = toWellFormedUnicode(body);
  return wellFormed.length > 240
    ? `${truncateWellFormed(wellFormed, 237)}...`
    : wellFormed;
}

function preview197(body: string): string {
  const wellFormed = toWellFormedUnicode(body);
  if (wellFormed.length <= 200) return wellFormed;
  return `${truncateWellFormed(wellFormed, 197)}...`;
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("owner-send-policy surrogate handling", () => {
  it("237 backs off at surrogate (236+fox->236 before ...)", () => {
    const input = `${"a".repeat(236)}🦊${"b".repeat(50)}`;
    const out = preview237(input);
    expect(isWellFormed(out)).toBe(true);
    // 236 + "..." = 239 total, but core is 236
    expect(out.slice(0, -3).length).toBe(236);
  });

  it("237 preserves fitting emoji (235+fox intact)", () => {
    const input = `${"a".repeat(235)}🦊${"b".repeat(100)}`;
    const out = preview237(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.slice(0, -3)).toBe(`${"a".repeat(235)}🦊`);
  });

  it("197 backs off at surrogate", () => {
    const input = `${"a".repeat(196)}🦊${"b".repeat(50)}`;
    const out = preview197(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.slice(0, -3).length).toBe(196);
  });

  it("short body passes through", () => {
    const input = "short body";
    expect(preview237(input)).toBe(input);
    expect(preview197(input)).toBe(input);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `body ${String.fromCharCode(0xd800)} text ${"a".repeat(500)}`;
    const out237 = preview237(lone);
    const out197 = preview197(lone);
    expect(isWellFormed(out237)).toBe(true);
    expect(isWellFormed(out197)).toBe(true);
    expect(out237.includes("�")).toBe(true);
  });
});
