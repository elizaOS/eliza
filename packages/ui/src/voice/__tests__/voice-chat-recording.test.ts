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

    it("applies NFKC compatibility folding before stripping punctuation", () => {
      expect(
        normalizeTranscriptWord("\uFF28\uFF45\uFF4C\uFF4C\uFF4F\uFF0C"),
      ).toBe("hello");
      expect(normalizeTranscriptWord("\uFB01re")).toBe("fire");
      expect(normalizeTranscriptWord("\u4f60\u597d\u3002")).toBe(
        "\u4f60\u597d",
      );
    });

    it("preserves interior punctuation and digits while trimming only the edges", () => {
      expect(normalizeTranscriptWord("don't")).toBe("don't");
      expect(normalizeTranscriptWord("state-of-the-art.")).toBe(
        "state-of-the-art",
      );
      expect(normalizeTranscriptWord("42!")).toBe("42");
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

    it("returns the collapsed counterpart when exactly one side is empty", () => {
      expect(mergeTranscriptWindows("  spaced   out\t", "")).toBe("spaced out");
      expect(mergeTranscriptWindows("", "\n inner   join ")).toBe("inner join");
    });

    it("collapses noisy whitespace inside both windows before merging", () => {
      expect(mergeTranscriptWindows("alpha   beta", "beta\ngamma")).toBe(
        "alpha beta gamma",
      );
    });

    it("uses the longest overlap window when several could match", () => {
      expect(mergeTranscriptWindows("a b c d e", "c d e f g")).toBe(
        "a b c d e f g",
      );
    });

    it("matches overlapping words case-insensitively while keeping left casing", () => {
      expect(mergeTranscriptWindows("Hello World FOO", "foo bar baz")).toBe(
        "Hello World FOO bar baz",
      );
    });

    it("deduplicates identical single-word windows to the retained left text", () => {
      expect(mergeTranscriptWindows("one", "one")).toBe("one");
    });

    it("concatenates disjoint single-word windows without inserting a separator", () => {
      expect(mergeTranscriptWindows("one", "two")).toBe("onetwo");
    });

    it("never lets punctuation-only tokens satisfy an overlap position", () => {
      expect(mergeTranscriptWindows("wow !!! next", "next more")).toBe(
        "wow !!! next more",
      );
    });
  });
});
