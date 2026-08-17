/**
 * Exercises terminal output bounds through the production formatting helpers.
 * The deterministic cases cover omission accounting, tiny limits, and Unicode.
 */
import { describe, expect, it } from "vitest";
import { buildOutputPreview, truncateForData } from "./terminal.ts";

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("terminal output truncation", () => {
  it("keeps the preview and its truthful omission count within the cap", () => {
    const content = "x".repeat(4_000);
    const preview = buildOutputPreview(content, 3_000);
    const marker = preview.match(
      /\n\n\[\.\.\. (\d+) chars omitted; use the attachment for full output \.\.\.\]$/,
    );

    expect(preview.length).toBeLessThanOrEqual(3_000);
    expect(marker).not.toBeNull();
    const prefixLength = preview.length - (marker?.[0].length ?? 0);
    expect(Number(marker?.[1])).toBe(content.length - prefixLength);
  });

  it("never leaves a lone surrogate at either terminal boundary", () => {
    const content = "a😀".repeat(6_000);

    for (let max = 14; max <= 80; max++) {
      expect(hasLoneSurrogate(buildOutputPreview(content, max))).toBe(false);
      expect(hasLoneSurrogate(truncateForData(content, max))).toBe(false);
    }
  });

  it("uses content when a marker cannot fit and honors nonpositive limits", () => {
    expect(buildOutputPreview("abcdef", 3)).toBe("abc");
    expect(truncateForData("abcdef", 3)).toBe("abc");
    expect(buildOutputPreview("   ", 4)).toBe("(emp");
    expect(buildOutputPreview("abcdef", 0)).toBe("");
    expect(truncateForData("abcdef", -1)).toBe("");
  });
});
