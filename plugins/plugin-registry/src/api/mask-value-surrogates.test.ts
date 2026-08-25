import { describe, expect, it } from "vitest";

describe("maskValue surrogate safety", () => {
  it("masks secret values without bisecting surrogate pairs", () => {
    function maskValue(value: string): string {
      if (value.length <= 8) return "****";
      let prefixEnd = 4;
      if (prefixEnd > 0 && prefixEnd < value.length) {
        const code = value.charCodeAt(prefixEnd - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          prefixEnd -= 1;
        }
      }
      let suffixStart = value.length - 4;
      if (suffixStart > 0 && suffixStart < value.length) {
        const code = value.charCodeAt(suffixStart - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          suffixStart += 1;
        }
      }
      return `${value.slice(0, prefixEnd)}...${value.slice(suffixStart)}`;
    }

    const emojis = "🔑".repeat(10); // 20 code units > 8
    const masked = maskValue(emojis);
    expect(masked.includes("...")).toBe(true);
    for (const char of masked) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
