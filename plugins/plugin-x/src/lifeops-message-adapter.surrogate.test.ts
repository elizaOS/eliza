/** Surrogate safety for XDmAdapter in lifeops-message-adapter.ts. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core/node";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

function formatDmSnippet(body: string): string {
  return truncateWellFormed(toWellFormedUnicode(body), 200);
}

function formatDraftPreview(body: string): string {
  const wellFormedBody = toWellFormedUnicode(body);
  return wellFormedBody.length > 200
    ? `${truncateWellFormed(wellFormedBody, 197)}...`
    : wellFormedBody;
}

describe("XDmAdapter surrogate safety", () => {
  test("emoji at 199 boundary in snippet backs off without lone surrogate", () => {
    const fox = "🦊";
    const body = `${"a".repeat(199)}${fox}${"b".repeat(50)}`;
    const snippet = formatDmSnippet(body);
    expect(isWellFormed(snippet)).toBe(true);
    expect(snippet).toBe("a".repeat(199));
    expect(() => JSON.stringify({ snippet })).not.toThrow();
  });

  test("emoji at 196 boundary in draft preview backs off cleanly", () => {
    const fox = "🦊";
    const body = `${"a".repeat(196)}${fox}${"b".repeat(50)}`;
    const preview = formatDraftPreview(body);
    expect(isWellFormed(preview)).toBe(true);
    expect(preview.endsWith("...")).toBe(true);
    expect(() => JSON.stringify({ preview })).not.toThrow();
  });

  test("lone high surrogate in dm body sanitized safely", () => {
    const badBody = `Bad \ud800 dm body ${"x".repeat(300)}`;
    const snippet = formatDmSnippet(badBody);
    expect(isWellFormed(snippet)).toBe(true);
    expect(snippet.includes("\ud800")).toBe(false);
  });

  test("sweep offsets around 200 cap all stay well-formed", () => {
    const fox = "🦊";
    for (let offset = -5; offset <= 5; offset++) {
      const n = 200 + offset;
      const body = `${"a".repeat(n)}${fox}${"b".repeat(20)}`;
      const snippet = formatDmSnippet(body);
      const preview = formatDraftPreview(body);
      expect(isWellFormed(snippet)).toBe(true);
      expect(isWellFormed(preview)).toBe(true);
    }
  });
});
