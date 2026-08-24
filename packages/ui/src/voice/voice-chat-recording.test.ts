/**
 * Unit tests for voice-chat-recording: validates transcript token normalization and sliding-window merging.
 */
import { describe, expect, it } from "vitest";
import {
  mergeTranscriptWindows,
  normalizeTranscriptWord,
} from "./voice-chat-recording.ts";

describe("voice-chat-recording", () => {
  it("normalizes words by lowercasing, NFKC decomposing, and trimming unicode punctuation", () => {
    expect(normalizeTranscriptWord("Hello,")).toBe("hello");
    expect(normalizeTranscriptWord("...world?!")).toBe("world");
    expect(normalizeTranscriptWord("\u00c9liza")).toBe("\u00e9liza");
  });

  it("merges non-overlapping and exact streaming text chunks", () => {
    expect(mergeTranscriptWindows("", "incoming text")).toBe("incoming text");
    expect(mergeTranscriptWindows("existing text", "")).toBe("existing text");
    expect(mergeTranscriptWindows("Hello", "Hello world")).toBe("Hello world");
    expect(mergeTranscriptWindows("Hello world", "Hello world")).toBe(
      "Hello world",
    );
  });

  it("detects and stitches multi-word overlaps across transcript windows", () => {
    const existing = "The quick brown fox jumps";
    const incoming = "fox jumps over the lazy dog";
    const merged = mergeTranscriptWindows(existing, incoming);
    expect(merged).toBe("The quick brown fox jumps over the lazy dog");

    const ex2 = "Listening for audio";
    const in2 = "audio stream chunks";
    expect(mergeTranscriptWindows(ex2, in2)).toBe(
      "Listening for audio stream chunks",
    );
  });
});
