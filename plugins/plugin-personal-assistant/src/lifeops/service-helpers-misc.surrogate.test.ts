/**
 * Surrogate-safe truncation for service-helpers-misc generated text (277 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function normalizeGeneratedLifeOpsAssistantText(value: string): string | null {
  const cleaned = value
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const wellFormed = toWellFormedUnicode(cleaned);
  return wellFormed.length > 280
    ? `${truncateWellFormed(wellFormed, 277).trimEnd()}...`
    : wellFormed;
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("service-helpers-misc surrogate handling", () => {
  it("277 backs off at surrogate (276+fox->276 before ...)", () => {
    const input = "a".repeat(276) + "🦊" + "b".repeat(50);
    const out = normalizeGeneratedLifeOpsAssistantText(input)!;
    expect(isWellFormed(out)).toBe(true);
    const core = out.slice(0, -3).trimEnd();
    expect(core.length).toBe(276);
  });

  it("277 preserves fitting emoji (275+fox intact)", () => {
    const input = "a".repeat(275) + "🦊" + "b".repeat(50);
    const out = normalizeGeneratedLifeOpsAssistantText(input)!;
    expect(isWellFormed(out)).toBe(true);
    expect(out.slice(0, -3).trimEnd()).toBe("a".repeat(275) + "🦊");
  });

  it("short cleaned passes through well-formed", () => {
    const input = "short cleaned text";
    const out = normalizeGeneratedLifeOpsAssistantText(input)!;
    expect(out).toBe("short cleaned text");
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone =
      `text ${String.fromCharCode(0xd800)} content ` + "a".repeat(500);
    const out = normalizeGeneratedLifeOpsAssistantText(lone)!;
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("returns null for empty", () => {
    expect(normalizeGeneratedLifeOpsAssistantText("   ")).toBe(null);
  });
});
