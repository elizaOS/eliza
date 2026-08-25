import { describe, expect, it } from "vitest";

describe("manageBrowserBridge error text surrogate safety", () => {
  it("truncates error text without bisecting surrogate pairs", () => {
    function truncateText(text: string, maxChars: number): string {
      if (text.length <= maxChars) return text;
      let end = maxChars;
      if (end > 0 && end < text.length) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          end -= 1;
        }
      }
      return text.slice(0, end);
    }

    const MAX_BROWSER_BRIDGE_TEXT_LENGTH = 280;
    const emojis = "🌉".repeat(200); // 400 code units > 280
    const rawText = `Failed MANAGE_BROWSER_BRIDGE install: ${emojis}`;
    const result = truncateText(rawText, MAX_BROWSER_BRIDGE_TEXT_LENGTH);
    for (const char of result) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
