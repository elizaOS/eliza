import { describe, expect, it } from "vitest";

describe("calendar description surrogate safety", () => {
  it("truncates description without bisecting surrogate pairs", () => {
    function truncateCalendarText(text: string, maxChars: number): string {
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

    const emojis = "🎉".repeat(100); // 200 code units
    const truncated = truncateCalendarText(emojis, 121);
    expect(truncated.length).toBe(120); // rounded down to avoid cutting high surrogate
    for (const char of truncated) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
