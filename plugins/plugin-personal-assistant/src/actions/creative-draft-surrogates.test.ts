import { describe, expect, it } from "vitest";

describe("creative-draft voice source surrogate safety", () => {
  it("truncates voice source text without bisecting surrogate pairs", () => {
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

    const emojis = "✍️".repeat(2000);
    const result = truncateText(emojis, 3001);
    for (const char of result) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
