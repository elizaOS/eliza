/**
 * Regression for automation-terminal-bridge surrogate-safe truncation (300).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const TERMINAL_BRIDGE_LIMIT = 300;

function clampTerminal(text: string): string {
  const wellFormed = toWellFormedUnicode(text ?? "");
  return truncateWellFormed(wellFormed, TERMINAL_BRIDGE_LIMIT);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("automation-terminal-bridge well-formed", () => {
  it("backs off astral at 300 boundary (299+fox->299)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(299)}${fox}${"b".repeat(20)}`;
    const out = clampTerminal(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(299);
    expect(out).toBe("a".repeat(299));
  });

  it("preserves fitting astral at 300 (298+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(298)}${fox}`;
    const out = clampTerminal(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(300);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `term ${String.fromCharCode(0xd800)} text`;
    const out = clampTerminal(`${lone}${"x".repeat(400)}`);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("short passthrough", () => {
    expect(clampTerminal("short terminal")).toBe("short terminal");
  });

  it("sweep around 300 well-formed", () => {
    const fox = "🦊";
    for (let n = 295; n <= 305; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampTerminal(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(300);
    }
  });
});
