import { describe, expect, it } from "vitest";
import { splitSpeechSegments } from "../speech-segments";

describe("caption speech chunks", () => {
  it("retains decimals, abbreviations and complete text", () => {
    const text = "Dr. Reed owes $12.50. Check the account! Then stop.";
    expect(splitSpeechSegments(text)).toEqual([
      "Dr. Reed owes $12.50.",
      "Check the account!",
      "Then stop.",
    ]);
  });
  it("preserves words in long unpunctuated replies and empty input", () => {
    const text = Array.from({ length: 100 }, (_, n) => `word${n}`).join(" ");
    const chunks = splitSpeechSegments(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(" ")).toBe(text);
    expect(splitSpeechSegments("  ")).toEqual([]);
  });
});
