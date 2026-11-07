import { describe, expect, it } from "vitest";
import { splitMessageForIMessage } from "../src/types.ts";

describe("iMessage grapheme boundaries", () => {
  it.each(["👩🏽‍💻", "🇰🇷", "e\u0301", "👨‍👩‍👧‍👦"])(
    "preserves %s across provider parts",
    (cluster) => {
      const text = cluster.repeat(5);
      const parts = splitMessageForIMessage(text, cluster.length * 2);
      expect(parts).toEqual([cluster.repeat(2), cluster.repeat(2), cluster]);
      expect(parts.join("")).toBe(text);
    }
  );

  it("makes progress through an oversized cluster without dropping scalars", () => {
    const text = "👨‍👩‍👧‍👦".repeat(3);
    const parts = splitMessageForIMessage(text, 3);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => part.length > 0 && part.length <= 3 && part.isWellFormed())).toBe(
      true
    );
  });
});
