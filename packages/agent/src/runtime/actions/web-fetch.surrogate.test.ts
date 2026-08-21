/** Surrogate safety for web-fetch snippet truncation. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

const WEB_FETCH_SNIPPET_CHARS = 4_000;

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function snippet(body: string): string {
  return truncateWellFormed(toWellFormedUnicode(body), WEB_FETCH_SNIPPET_CHARS);
}

describe("web-fetch surrogate safety", () => {
  test("4000 boundary backs off at surrogate without lone", () => {
    const fox = "🦊";
    const body = `${"a".repeat(3_999)}${fox}${"b".repeat(100)}`;
    const out = snippet(body);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(3_999);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
  test("short body passthrough", () => {
    const out = snippet("short body 🦊");
    expect(out).toBe(toWellFormedUnicode("short body 🦊"));
    expect(isWellFormed(out)).toBe(true);
  });
  test("emoji at 4000 fits", () => {
    const fox = "🦊";
    const body = `${"a".repeat(3_998)}${fox}`;
    const out = snippet(body);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes(fox)).toBe(true);
    expect(out.length).toBe(4_000);
  });
  test("lone surrogate sanitized", () => {
    const lone = `body ${String.fromCharCode(0xd800)} ${"x".repeat(5_000)}`;
    const out = snippet(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
  test("sweep offsets well-formed", () => {
    const fox = "🦊";
    for (let n = 3_995; n <= 4_005; n++) {
      const body = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
      const out = snippet(body);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
