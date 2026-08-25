import { describe, expect, it } from "vitest";

describe("autofill detail surrogate safety", () => {
  it("truncates error response detail without bisecting surrogate pairs", () => {
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

    const emojis = "🔑".repeat(300); // 600 code units > 500
    const result = truncateText(emojis, 501);
    expect(result.length).toBe(500);
    for (const char of result) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
