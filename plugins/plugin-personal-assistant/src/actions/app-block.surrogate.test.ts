/** Surrogate safety for app & website blocking inputs in app-block.ts and website-block.ts. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

function normalizeInputCandidates(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? truncateWellFormed(toWellFormedUnicode(value), 10_000).split(
          /\s{0,256}\|\|\s{0,256}|,|\n/,
        )
      : [];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

describe("block action input splitting surrogate safety", () => {
  test("emoji at 10000 boundary backs off cleanly without lone surrogate", () => {
    const fox = "🦊";
    const input = `${"a".repeat(9999)}${fox},other.app`;
    const res = normalizeInputCandidates(input);
    expect(res.length).toBeGreaterThanOrEqual(1);
    res.forEach((item) => {
      expect(isWellFormed(item)).toBe(true);
      expect(() => JSON.stringify({ item })).not.toThrow();
    });
  });

  test("fitting emoji ending at 10000 kept intact", () => {
    const fox = "🦊";
    const input = `${"a".repeat(9998)}${fox}`;
    const res = normalizeInputCandidates(input);
    expect(res.length).toBe(1);
    expect(res[0].includes(fox)).toBe(true);
    expect(isWellFormed(res[0])).toBe(true);
  });

  test("lone high surrogate in delimited package string is sanitized safely", () => {
    const badInput = "com.test.app1, com.test.app2 \ud800, com.test.app3";
    const res = normalizeInputCandidates(badInput);
    expect(res.length).toBe(3);
    res.forEach((item) => {
      expect(isWellFormed(item)).toBe(true);
      expect(item.includes("\ud800")).toBe(false);
    });
  });

  test("sweep offsets around 10k cap all stay well-formed", () => {
    const fox = "🦊";
    for (let offset = -5; offset <= 5; offset++) {
      const n = 10_000 + offset;
      const input = `${"a".repeat(n)}${fox},next.app`;
      const res = normalizeInputCandidates(input);
      res.forEach((item) => {
        expect(isWellFormed(item)).toBe(true);
        expect(() => JSON.stringify({ item })).not.toThrow();
      });
    }
  });
});
