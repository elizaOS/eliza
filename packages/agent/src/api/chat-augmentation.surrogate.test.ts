/**
 * Regression for chat-augmentation document snippet truncation surrogate safety.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const CHAT_DOCUMENTS_SNIPPET_MAX_CHARS = 1200;

function formatDocumentSnippet(rawText: string): string {
  const text = toWellFormedUnicode(rawText.trim());
  return text.length > CHAT_DOCUMENTS_SNIPPET_MAX_CHARS
    ? `${truncateWellFormed(text, CHAT_DOCUMENTS_SNIPPET_MAX_CHARS - 3)}...`
    : text;
}

function isWellFormed(v: string): boolean {
  if (!v) return true;
  if (
    typeof (v as unknown as { isWellFormed?: () => boolean }).isWellFormed ===
    "function"
  )
    return (v as unknown as { isWellFormed: () => boolean }).isWellFormed();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = v.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("chat-augmentation snippet surrogate safety", () => {
  it("keeps surrogate pair intact at 1197 boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(1196)}${fox}${"b".repeat(50)}`;
    const out = formatDocumentSnippet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(out).not.toContain("\uD83E");
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `document preview ${fox}`;
    const out = formatDocumentSnippet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes lone surrogate in document excerpt", () => {
    const lone = `doc ${String.fromCharCode(0xd800)} ${"a".repeat(2000)}`;
    const out = formatDocumentSnippet(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
  });
});
