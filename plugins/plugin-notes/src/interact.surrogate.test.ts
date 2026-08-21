/** Surrogate safety for sticky note planner summary in interact.ts. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

const PLANNER_SUMMARY_EXCERPT_LENGTH = 160;

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

function humanDetails(value: string): string {
  const details = toWellFormedUnicode(value.trim());
  return details.length > 0
    ? ` — ${truncateWellFormed(details, PLANNER_SUMMARY_EXCERPT_LENGTH)}`
    : "";
}

describe("notes interact summary excerpt surrogate safety", () => {
  test("emoji at 159 boundary backs off cleanly without lone surrogate", () => {
    const fox = "🦊";
    const body = `${"a".repeat(159)}${fox}${"b".repeat(50)}`;
    const details = humanDetails(body);
    expect(isWellFormed(details)).toBe(true);
    expect(details).toBe(` — ${"a".repeat(159)}`);
    expect(() => JSON.stringify({ details })).not.toThrow();
  });

  test("fitting emoji ending at 160 kept intact", () => {
    const fox = "🦊";
    const body = `${"a".repeat(158)}${fox}`;
    const details = humanDetails(body);
    expect(isWellFormed(details)).toBe(true);
    expect(details.includes(fox)).toBe(true);
  });

  test("lone high surrogate in note body sanitized safely", () => {
    const badBody = `Note content with \ud800 corrupt surrogate ${"x".repeat(200)}`;
    const details = humanDetails(badBody);
    expect(isWellFormed(details)).toBe(true);
    expect(details.includes("\ud800")).toBe(false);
  });

  test("sweep offsets around 160 cap all stay well-formed", () => {
    const fox = "🦊";
    for (let offset = -5; offset <= 5; offset++) {
      const n = 160 + offset;
      const body = `${"a".repeat(n)}${fox}${"b".repeat(20)}`;
      const details = humanDetails(body);
      expect(isWellFormed(details)).toBe(true);
      expect(() => JSON.stringify({ details })).not.toThrow();
    }
  });
});
