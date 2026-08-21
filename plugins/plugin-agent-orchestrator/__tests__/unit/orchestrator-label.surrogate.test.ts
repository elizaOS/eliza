/**
 * Regression for orchestrator label surrogate safety (80).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function labelFrom(task: string, index: number): string {
  const cleaned = task.replace(/\s+/g, " ").trim();
  const wellFormed = toWellFormedUnicode(cleaned);
  return wellFormed ? truncateWellFormed(wellFormed, 80) : `task-${index + 1}`;
}

function isWellFormed(value: string): boolean {
  if (!value) return true;
  if (
    typeof (value as unknown as { isWellFormed?: () => boolean })
      .isWellFormed === "function"
  )
    return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("orchestrator label well-formed", () => {
  it("keeps surrogate intact at 80 boundary", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(79)}${emoji}${"b".repeat(20)}`;
    const out = labelFrom(input, 0);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it("preserves fitting emoji", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(78)}${emoji}`;
    const out = labelFrom(input, 0);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes(emoji)).toBe(true);
    expect(out.length).toBe(80);
  });

  it("sanitizes lone surrogate", () => {
    const lone = `task ${String.fromCharCode(0xd800)} label`;
    const out = labelFrom(`${lone}${"x".repeat(100)}`, 0);
    expect(isWellFormed(out)).toBe(true);
  });

  it("short passthrough", () => {
    expect(labelFrom("short task", 0)).toBe("short task");
    expect(labelFrom("", 5)).toBe("task-6");
  });

  it("sweep around 80 well-formed", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 75; n <= 85; n++) {
      const input = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const out = labelFrom(input, 0);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(80);
    }
  });
});
