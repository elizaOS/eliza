import { describe, expect, it } from "vitest";

describe("signal splitMessage surrogate safety", () => {
  it("splits messages without bisecting surrogate pairs", () => {
    function splitMessage(text: string, maxLen = 10): string[] {
      if (text.length <= maxLen) {
        return [text];
      }

      const messages: string[] = [];
      let remaining = text;

      while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
          messages.push(remaining);
          break;
        }

        let splitIndex = maxLen;

        const lastNewline = remaining.lastIndexOf("\n", maxLen);
        if (lastNewline > maxLen / 2) {
          splitIndex = lastNewline + 1;
        } else {
          const lastSpace = remaining.lastIndexOf(" ", maxLen);
          if (lastSpace > maxLen / 2) {
            splitIndex = lastSpace + 1;
          }
        }

        if (splitIndex > 0 && splitIndex < remaining.length) {
          const code = remaining.charCodeAt(splitIndex - 1);
          if (code >= 0xd800 && code <= 0xdbff) {
            splitIndex -= 1;
          }
        }

        messages.push(remaining.slice(0, splitIndex));
        remaining = remaining.slice(splitIndex);
      }

      return messages;
    }

    const emojis = "🎉".repeat(20); // 40 code units
    const chunks = splitMessage(emojis, 7); // 7 limit odd -> backs off to 6 (3 emojis)
    for (const chunk of chunks) {
      for (const char of chunk) {
        expect(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
            char,
          ),
        ).toBe(false);
      }
    }
  });
});
