/**
 * Unit tests for voice chat recording transcript word normalization and window merging.
 */
import { describe, expect, it } from "vitest";
import {
  mergeTranscriptWindows,
  normalizeTranscriptWord,
} from "../voice-chat-recording.ts";

describe("voice-chat-recording", () => {
  describe("normalizeTranscriptWord", () => {
    it("converts ASCII and Unicode words to lowercase and trims leading/trailing punctuation", () => {
      expect(normalizeTranscriptWord("Hello,")).toBe("hello");
      expect(normalizeTranscriptWord("\u201cQuote\u201d")).toBe("quote");
      expect(normalizeTranscriptWord("...Wait?!")).toBe("wait");
      expect(normalizeTranscriptWord("\u00c9mile")).toBe("\u00e9mile");
    });

    it("handles words composed entirely of punctuation or symbols", () => {
      expect(normalizeTranscriptWord("---")).toBe("");
      expect(normalizeTranscriptWord("?!#")).toBe("");
      expect(normalizeTranscriptWord("")).toBe("");
    });
  });

  describe("mergeTranscriptWindows", () => {
    it("handles empty or whitespace-only inputs", () => {
      expect(mergeTranscriptWindows("", "Hello world")).toBe("Hello world");
      expect(mergeTranscriptWindows("Hello world", "")).toBe("Hello world");
      expect(mergeTranscriptWindows("   ", "   ")).toBe("");
    });

    it("merges sliding STT transcript windows with overlapping words", () => {
      const existing = "The quick brown fox";
      const incoming = "brown fox jumps over the lazy dog";
      const merged = mergeTranscriptWindows(existing, incoming);
      expect(merged).toBe("The quick brown fox jumps over the lazy dog");
    });

    it("handles punctuation differences during word overlap matching", () => {
      const existing = "How are you today?";
      const incoming = "today, let us go outside.";
      const merged = mergeTranscriptWindows(existing, incoming);
      expect(merged).toBe("How are you today? let us go outside.");
    });

    it("returns left when incoming is a subset of the existing tail", () => {
      const existing = "one two three four";
      const incoming = "three four";
      const merged = mergeTranscriptWindows(existing, incoming);
      expect(merged).toBe("one two three four");
    });

    it("appends non-overlapping speech streams without dropping words", () => {
      const existing = "First sentence.";
      const incoming = "Second sentence.";
      const merged = mergeTranscriptWindows(existing, incoming);
      expect(merged).toContain("First sentence.");
      expect(merged).toContain("Second sentence.");
    });
  });
});
