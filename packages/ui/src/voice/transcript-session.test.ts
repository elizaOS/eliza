import { describe, expect, it } from "vitest";
import { TranscriptSessionAccumulator } from "./transcript-session";

describe("TranscriptSessionAccumulator", () => {
  it("folds utterances into contiguous, session-relative segments", () => {
    const acc = new TranscriptSessionAccumulator(1000);
    acc.addFinal("hello there", 2000); // 0..1000
    acc.addFinal("how are you", 3500, "Alice"); // 1000..2500
    expect(acc.count).toBe(2);
    expect(acc.build()).toEqual([
      {
        id: "seg-0",
        speakerLabel: undefined,
        startMs: 0,
        endMs: 1000,
        text: "hello there",
        words: [],
      },
      {
        id: "seg-1",
        speakerLabel: "Alice",
        startMs: 1000,
        endMs: 2500,
        text: "how are you",
        words: [],
      },
    ]);
  });

  it("ignores empty/whitespace utterances", () => {
    const acc = new TranscriptSessionAccumulator(0);
    acc.addFinal("   ", 500);
    acc.addFinal("", 600);
    expect(acc.count).toBe(0);
    expect(acc.build()).toEqual([]);
  });

  it("guarantees a non-zero span even when finalize time regresses", () => {
    const acc = new TranscriptSessionAccumulator(1000);
    acc.addFinal("a", 1000); // nowMs == start → endMs floored to startMs+1
    expect(acc.build()[0]).toMatchObject({ startMs: 0, endMs: 1 });
  });
});
