import { describe, expect, it } from "vitest";

describe("approvalSafeLabel surrogate safety", () => {
  it("truncates approval labels without bisecting surrogate pairs", () => {
    function approvalSafeLabel(value: string): string {
      const sanitized = value
        .replace(/[\r\n\t]+/g, " ")
        .replace(/[[\]]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (sanitized.length <= 160) return sanitized;
      let end = 160;
      if (end > 0 && end < sanitized.length) {
        const code = sanitized.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          end -= 1;
        }
      }
      return sanitized.slice(0, end);
    }

    const emojis = "📅".repeat(100); // 200 code units > 160
    const label = approvalSafeLabel(emojis);
    expect(label.length).toBe(160);
    for (const char of label) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
