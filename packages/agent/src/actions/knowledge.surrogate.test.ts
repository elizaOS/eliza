/**
 * Regression for knowledge action surrogate-safe truncation (240).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const KNOWLEDGE_SNIPPET_LIMIT = 240;

function clampKnowledgeSnippet(text: string): string {
  const wellFormed = toWellFormedUnicode(text ?? "");
  return truncateWellFormed(wellFormed, KNOWLEDGE_SNIPPET_LIMIT);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("knowledge action well-formed", () => {
  it("backs off astral at 240 boundary (239+fox->239)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(239)}${fox}${"b".repeat(20)}`;
    const out = clampKnowledgeSnippet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(239);
    expect(out).toBe("a".repeat(239));
  });

  it("preserves fitting astral at 240 (238+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(238)}${fox}`;
    const out = clampKnowledgeSnippet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(240);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `know ${String.fromCharCode(0xd800)} text`;
    const out = clampKnowledgeSnippet(`${lone}${"x".repeat(300)}`);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("short passthrough", () => {
    expect(clampKnowledgeSnippet("short snippet")).toBe("short snippet");
  });

  it("sweep around 240 well-formed", () => {
    const fox = "🦊";
    for (let n = 235; n <= 245; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampKnowledgeSnippet(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(240);
    }
  });
});
