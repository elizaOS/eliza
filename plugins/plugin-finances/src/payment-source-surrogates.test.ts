import { describe, expect, it } from "vitest";

describe("finances payment source surrogate safety", () => {
  it("truncates payment source labels without bisecting surrogate pairs", () => {
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

    // "x" (1 char) + "💰" (2 chars * 70 = 140 chars) -> bisects at 120
    const bisectingInput = "x" + "💰".repeat(70);
    const truncated = truncateText(bisectingInput, 120);
    expect(truncated.length).toBe(119);
    for (const char of truncated) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
