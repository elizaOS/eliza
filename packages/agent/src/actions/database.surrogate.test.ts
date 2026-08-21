/**
 * Regression for database action surrogate-safe truncation (160).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const DATABASE_SNIPPET_LIMIT = 160;

function clampDatabaseSnippet(hitText: string): string {
  const wellFormed = toWellFormedUnicode(hitText ?? "");
  return truncateWellFormed(wellFormed, DATABASE_SNIPPET_LIMIT).replace(
    /\s+/g,
    " ",
  );
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("database action well-formed", () => {
  it("backs off astral at 160 boundary (159+fox->159)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(159)}${fox}${"b".repeat(20)}`;
    const out = clampDatabaseSnippet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(159);
    expect(out).toBe("a".repeat(159));
  });

  it("preserves fitting astral at 160 (158+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(158)}${fox}`;
    const out = clampDatabaseSnippet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(160);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `hit ${String.fromCharCode(0xd800)} text`;
    const out = clampDatabaseSnippet(`${lone}${"x".repeat(200)}`);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("short passthrough", () => {
    expect(clampDatabaseSnippet("short hit")).toBe("short hit");
  });

  it("sweep around 160 well-formed", () => {
    const fox = "🦊";
    for (let n = 155; n <= 165; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampDatabaseSnippet(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(160);
    }
  });
});
