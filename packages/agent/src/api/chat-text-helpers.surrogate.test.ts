/** Surrogate safety for chat-text-helpers tidy spacing. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function tidyClamp(input: string): string {
  const safe =
    input.length > 100_000
      ? truncateWellFormed(toWellFormedUnicode(input), 100_000)
      : toWellFormedUnicode(input);
  return safe;
}

describe("chat-text-helpers surrogate safety", () => {
  test("100k boundary backs off at surrogate without lone", () => {
    const fox = "🦊";
    const input = `${"a".repeat(99_999)}${fox}${"b".repeat(100)}`;
    const out = tidyClamp(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(99_999);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("short input well-formed passthrough", () => {
    const input = "short helper input 🦊";
    const out = tidyClamp(input);
    expect(out).toBe(toWellFormedUnicode(input));
    expect(isWellFormed(out)).toBe(true);
  });

  test("emoji at 100k fits intact", () => {
    const fox = "🦊";
    const input = `${"a".repeat(99_998)}${fox}`;
    const out = tidyClamp(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes(fox)).toBe(true);
    expect(out.length).toBe(100_000);
  });

  test("lone surrogate sanitized to replacement", () => {
    const lone = `${"a".repeat(50)}${String.fromCharCode(0xd800)}${"b".repeat(100_050)}`;
    const out = tidyClamp(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  test("sweep 100k offsets all well-formed", () => {
    const fox = "🦊";
    for (let n = 99_998; n <= 100_002; n++) {
      const input = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
      const out = tidyClamp(input);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
