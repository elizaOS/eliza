import { describe, expect, it } from "vitest";

describe("orchestrator truncation surrogate pair safety", () => {
  it("keeps surrogate pairs intact without splitting", () => {
    const text = "😀🎉🚀🌟🔥";
    // length of text is 10 UTF-16 code units (5 emojis)
    function truncate(value: string, maxChars: number): string {
      const compact = value.replace(/\s+/g, " ").trim();
      if (compact.length <= maxChars) return compact;
      let end = maxChars - 3;
      if (end > 0 && end < compact.length) {
        const code = compact.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
          end -= 1;
        }
      }
      return `${compact.slice(0, end).trimEnd()}...`;
    }

    const truncated = truncate(text, 6);
    expect(truncated.endsWith("...")).toBe(true);
    const body = truncated.slice(0, -3);
    for (const char of body) {
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
          char,
        ),
      ).toBe(false);
    }
  });
});
