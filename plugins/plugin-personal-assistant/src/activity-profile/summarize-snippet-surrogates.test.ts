import { describe, expect, it } from "vitest";

describe("summarizeSnippet surrogate safety", () => {
  it("truncates snippets without bisecting surrogate pairs", () => {
    function summarizeSnippet(value: string): string | null {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return null;
      }
      if (trimmed.length <= 72) {
        return trimmed;
      }
      let end = 69;
      if (end > 0 && end < trimmed.length) {
        const code = trimmed.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          end -= 1;
        }
      }
      return `${trimmed.slice(0, end).trimEnd()}...`;
    }

    const emojis = "🔥".repeat(50); // 100 code units > 72
    const snippet = summarizeSnippet(emojis);
    expect(snippet).not.toBeNull();
    expect(snippet!.endsWith("...")).toBe(true);
    for (const char of snippet!) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
