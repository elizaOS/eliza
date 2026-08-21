/** Surrogate safety for trigger displayName truncation. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function formatDisplayName(instructions: string): string {
  return `Trigger: ${truncateWellFormed(toWellFormedUnicode(instructions), 64)}`;
}

describe("trigger displayName surrogate safety", () => {
  test("emoji at 64 boundary backs off without lone surrogate", () => {
    const fox = "🦊";
    const instructions = `${"a".repeat(63)}${fox}${"b".repeat(20)}`;
    const out = formatDisplayName(instructions);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out.length).toBeLessThanOrEqual("Trigger: ".length + 64);
  });

  test("emoji at 63 fits well-formed", () => {
    const fox = "🦊";
    const instructions = `${"a".repeat(62)}${fox}tail`;
    const out = formatDisplayName(instructions);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes(fox)).toBe(true);
  });

  test("short instructions pass through", () => {
    const out = formatDisplayName("short instruction");
    expect(out).toBe("Trigger: short instruction");
    expect(isWellFormed(out)).toBe(true);
  });

  test("lone surrogate sanitized", () => {
    const lone = `instr ${String.fromCharCode(0xd800)} ${"x".repeat(100)}`;
    const out = formatDisplayName(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  test("sweep offsets all well-formed", () => {
    const fox = "🦊";
    for (let n = 60; n <= 68; n++) {
      const instr = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
      const out = formatDisplayName(instr);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
