import { describe, expect, it } from "vitest";
import { VoiceTtsChunker } from "./voice-tts-chunker";

describe("VoiceTtsChunker", () => {
  it("flushes on punctuation after the minimum length", () => {
    let now = 0;
    const chunker = new VoiceTtsChunker({
      now: () => now,
      config: {
        minChars: 10,
        maxChars: 200,
        flushOnPunctuation: true,
        maxDelayMs: 300,
      },
    });

    expect(chunker.pushDelta("hello")).toEqual([]);
    now += 10;
    expect(chunker.pushDelta(" world.")).toEqual([
      {
        sequence: 1,
        text: "hello world.",
        final: false,
        reason: "punctuation",
      },
    ]);
  });

  it("flushes on max chars without reordering text", () => {
    const chunker = new VoiceTtsChunker({
      config: {
        minChars: 5,
        maxChars: 12,
        flushOnPunctuation: false,
        maxDelayMs: 300,
      },
    });

    const chunks = chunker.pushDelta("hello world again");

    expect(chunks).toEqual([
      {
        sequence: 1,
        text: "hello world",
        final: false,
        reason: "max-chars",
      },
    ]);
    expect(chunker.flush()).toEqual([
      {
        sequence: 2,
        text: "again",
        final: true,
        reason: "final",
      },
    ]);
  });

  it("flushes on max delay and final flush", () => {
    let now = 0;
    const chunker = new VoiceTtsChunker({
      now: () => now,
      config: {
        minChars: 40,
        maxChars: 240,
        flushOnPunctuation: true,
        maxDelayMs: 25,
      },
    });

    expect(chunker.pushDelta("streaming")).toEqual([]);
    now = 30;
    expect(chunker.flushDue()).toEqual([
      {
        sequence: 1,
        text: "streaming",
        final: false,
        reason: "max-delay",
      },
    ]);
    expect(chunker.pushDelta(" done")).toEqual([]);
    expect(chunker.flush()).toEqual([
      {
        sequence: 2,
        text: "done",
        final: true,
        reason: "final",
      },
    ]);
  });
});
