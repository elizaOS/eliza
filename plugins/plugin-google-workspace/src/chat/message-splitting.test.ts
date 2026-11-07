import { describe, expect, it } from "vitest";
import { splitMessageForGoogleChat } from "./types.ts";

describe("Google Chat grapheme boundaries", () => {
  it.each(["👩🏽‍💻", "🇰🇷", "e\u0301", "👨‍👩‍👧‍👦"])(
    "preserves %s across provider parts",
    (cluster) => {
      const text = cluster.repeat(5);
      const limit = Buffer.byteLength(cluster) * 2;
      const parts = splitMessageForGoogleChat(text, limit);
      expect(parts.join("")).toBe(text);
      expect(parts.every((part) => Buffer.byteLength(part) <= limit)).toBe(true);
      expect(parts).toEqual([cluster.repeat(2), cluster.repeat(2), cluster]);
    }
  );

  it("keeps whitespace and oversized clusters without losing bytes", () => {
    const text = `hello \n  👨‍👩‍👧‍👦 ${"e\u0301".repeat(8)}\n`;
    const parts = splitMessageForGoogleChat(text, 7);
    expect(parts.join("")).toBe(text);
    expect(
      parts.every((part) => part.length > 0 && Buffer.byteLength(part) <= 7 && part.isWellFormed())
    ).toBe(true);
  });
});
