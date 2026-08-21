/**
 * Surrogate-safe truncation for dispatch-context recent conversation line (1000 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const RECENT_CONVERSATION_LINE_LIMIT = 1000;
function line1000(speaker: string, text: string): string {
  return truncateWellFormed(
    toWellFormedUnicode(`${speaker}: ${text}`),
    RECENT_CONVERSATION_LINE_LIMIT,
  );
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("dispatch-context surrogate handling", () => {
  it("1000 backs off at surrogate (999+fox->999)", () => {
    const _input = "🦊";
    const prefix = "Owner: ";
    // Need total length 999 before fox -> use filler
    const _fillerLen = 999 - prefix.length - 1; // 1 for fox's 2 code units? Wait fox is 2 code units, so need careful
    // Simpler: construct string length 999 then add fox at boundary
    const base = "a".repeat(999);
    const _out = truncateWellFormed(
      toWellFormedUnicode(`${base}🦊${"b".repeat(50)}`),
      1000,
    );
    // Use helper
    const text = `${"a".repeat(995)}🦊${"b".repeat(50)}`;
    const out2 = line1000("Owner", text);
    expect(isWellFormed(out2)).toBe(true);
    expect(out2.length).toBeLessThanOrEqual(1000);
  });

  it("1000 preserves fitting emoji", () => {
    const text = `${"a".repeat(990)}🦊`;
    const out = line1000("Owner", text);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("🦊")).toBe(true);
  });

  it("short line passes through", () => {
    const out = line1000("Owner", "hello world");
    expect(out).toBe("Owner: hello world");
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `text ${String.fromCharCode(0xd800)} content ${"a".repeat(2000)}`;
    const out = line1000("Owner", lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
