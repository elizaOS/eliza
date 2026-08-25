import { describe, expect, it } from "vitest";

describe("github action body surrogate safety", () => {
  it("truncates body without bisecting surrogate pairs", () => {
    function truncateBody(text: string, maxChars = 120): string {
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

    const emojis = "🚀".repeat(100); // 200 code units
    const result = truncateBody(emojis, 121);
    expect(result.length).toBe(120);
    for (const char of result) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
