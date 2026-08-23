/**
 * Regression: provider error strings are external and may contain lone surrogates;
 * route must use truncateWellFormed(toWellFormedUnicode(...),500).
 */

import { readFileSync } from "node:fs";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function formatError(message: string): string {
  return truncateWellFormed(toWellFormedUnicode(message), 500);
}

describe("generate-video surrogate-safe", () => {
  it("replaces lone surrogate before truncating", () => {
    const lone = "\uD800";
    const text = "a".repeat(499) + lone + "b".repeat(10);
    const old = text.slice(0, 500);
    expect(old.charCodeAt(499).toString(16)).toBe("d800");
    const safe = formatError(text);
    expect(safe.length).toBeLessThanOrEqual(500);
    expect(safe.includes("\uFFFD") || !safe.includes("\uD800")).toBe(true);
  });
  it("does not split astral at boundary", () => {
    const astral = "🦊";
    const text = "x".repeat(499) + astral + "y".repeat(10);
    const safe = formatError(text);
    expect(safe.length).toBeLessThanOrEqual(500);
  });
  it("caps at 500", () => {
    const long = "a".repeat(800);
    expect(formatError(long).length).toBe(500);
  });
  it("route file imports and uses truncateWellFormed", () => {
    const src = readFileSync(
      new URL("./route.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(src).toContain('from "@elizaos/core"');
    expect(src).toContain("truncateWellFormed");
    expect(src).toContain("toWellFormedUnicode");
    // ensure not inside generative-route-auth block
    expect(src).not.toMatch(
      /import \{[^}]*toWellFormedUnicode[^}]*from "@\/api-app\/lib\/generative-route-auth"/s,
    );
  });
});
