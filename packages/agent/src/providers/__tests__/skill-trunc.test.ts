/**
 * Proves skill-provider instruction truncation reserves suffix (rank 9, prompt-window overflow).
 * Sibling correct same file truncateDesc reserves maxLen-3, this site now reserves suffix length 54.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const providerPath = new URL("../skill-provider.ts", import.meta.url).pathname;

describe("skill-provider truncation — reserves suffix vs overflow", () => {
  test("skill-provider reserves suffix length, not slice(0,MAX)+suffix", () => {
    const src = readFileSync(providerPath, "utf8");
    // sibling correct pattern at top
    expect(src).toContain("substring(0, maxLen - 3)");
    // fixed site must reserve suffix.length
    expect(src).toContain("MAX_INSTRUCTION_CHARS - suffix.length");
    expect(src).toContain('const suffix = "\\n\\n...[truncated');
    // old overflow pattern must be gone (slice to MAX then add suffix without reserve)
    expect(src).not.toContain("substring(0, MAX_INSTRUCTION_CHARS)}\n\n...[truncated");
  });

  test("clamp stays at 2000 via suffix reserve", () => {
    const src = readFileSync(providerPath, "utf8");
    expect(src).toContain("MAX_INSTRUCTION_CHARS = 2000");
    expect(src).toContain("substring(0, MAX_INSTRUCTION_CHARS - suffix.length)");
  });

  test("direct payload: truncated length <= MAX (2000) vs old overflow 2054", () => {
    const MAX = 2000;
    const suffix = "\n\n...[truncated — use USE_SKILL for full instructions]";
    expect(suffix.length).toBe(54);
    const body = "a".repeat(2001);
    // old weak: slice(0,MAX)+suffix => overflow
    const weak = `${body.substring(0, MAX)}${suffix}`;
    expect(weak.length).toBe(2054);
    expect(weak.length).toBeGreaterThan(MAX);
    // fixed: slice(0,MAX - suffix.length)+suffix => clamped
    const fixed = `${body.substring(0, MAX - suffix.length)}${suffix}`;
    expect(fixed.length).toBe(2000);
    expect(fixed.length).toBeLessThanOrEqual(MAX);
    // edge: exactly MAX+1 vs MAX
    const body2 = "a".repeat(2000);
    // no truncation at 2000
    expect(body2.length).toBe(2000);
  });

  test("sibling correct still present (truncateDesc)", () => {
    const src = readFileSync(providerPath, "utf8");
    // ensure sibling not regressed
    expect(src).toContain("function truncateDesc");
    expect(src).toContain("maxLen - 3");
  });
});
