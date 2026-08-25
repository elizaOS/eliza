/**
 * Regression for LifeOps anticipation surrogate-safe truncation.
 */

import { describe, expect, it } from "vitest";

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

async function clampSnippet(value: string): Promise<string> {
  const _mod = await import("./store.js");
  const SNIPPET_MAX_LENGTH = 160;
  const { toWellFormedUnicode, truncateWellFormed } = await import(
    "@elizaos/core"
  );
  const wellFormed = toWellFormedUnicode(value.trim());
  if (wellFormed.length <= SNIPPET_MAX_LENGTH) return wellFormed;
  return `${truncateWellFormed(wellFormed, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

describe("anticipation clampSnippet well-formed Unicode", () => {
  it("keeps surrogate pairs intact at 159 budget", async () => {
    const text = `${"a".repeat(159 - 1)}🦊${"b".repeat(50)}`;
    const out = await clampSnippet(text);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("preserves fitting emoji", async () => {
    const text = `${"a".repeat(50)}🦊`;
    const out = await clampSnippet(text);
    expect(out).toBe(text);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate before truncation", async () => {
    const lone = `anticipation \uD800 ${"b".repeat(200)}`;
    const out = await clampSnippet(lone);
    expect(out).toContain("\uFFFD");
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone low surrogate without truncation", async () => {
    const lone = "anticipation \uDC00 checkin";
    const out = await clampSnippet(lone);
    expect(out).toBe("anticipation \uFFFD checkin");
    expect(isWellFormed(out)).toBe(true);
  });
});
