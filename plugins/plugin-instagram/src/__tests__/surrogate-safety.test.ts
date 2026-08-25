import { describe, expect, it } from "vitest";

describe("Instagram comment surrogate safety", () => {
  it("truncates long comments without bisecting surrogate pairs", () => {
    const MAX_COMMENT_LENGTH = 2200;
    function truncateInstagramComment(text: string): string {
      if (text.length <= MAX_COMMENT_LENGTH) return text;
      let end = MAX_COMMENT_LENGTH - 3;
      if (end > 0 && end < text.length) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          end -= 1;
        }
      }
      return `${text.slice(0, end)}...`;
    }

    const emojis = "📸".repeat(1500); // 3000 code units > 2200
    const truncated = truncateInstagramComment(emojis);
    expect(truncated.endsWith("...")).toBe(true);
    for (const char of truncated) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
