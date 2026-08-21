/**
 * Sentence-aware TTS streaming tests for the voice playback helpers.
 *
 * Exercises the exported sentence splitting, remainder, and cache-decision
 * helpers directly without requiring a React render.
 */
import { describe, expect, it } from "vitest";
import {
  remainderAfter,
  shouldCacheGeneratedSpeech,
  splitFirstSentence,
} from "../voice-chat-playback";

describe("splitFirstSentence", () => {
  it("returns complete sentence when punctuation arrives", () => {
    const result = splitFirstSentence("Hello there. How are you?");
    expect(result.complete).toBe(true);
    expect(result.firstSentence).toBe("Hello there.");
    expect(result.remainder).toBe("How are you?");
  });

  it("waits for boundary when no terminal punctuation is present", () => {
    const result = splitFirstSentence("Hello there");
    expect(result.complete).toBe(false);
    expect(result.firstSentence).toBe("Hello there");
    expect(result.remainder).toBe("");
  });

  it("handles question and exclamation marks as boundaries", () => {
    expect(splitFirstSentence("What? Yes!").firstSentence).toBe("What?");
    expect(splitFirstSentence("Wow! Great.").firstSentence).toBe("Wow!");
  });

  it("treats decimals like 3.14 as not a sentence boundary", () => {
    const result = splitFirstSentence("Pi is 3.14 approximately. The end.");
    expect(result.firstSentence).toBe("Pi is 3.14 approximately.");
  });

  it("falls back to 180-char chunking when no punctuation arrives", () => {
    const longRun = `${"word ".repeat(40).trim()} more`;
    expect(longRun.length).toBeGreaterThan(180);
    const result = splitFirstSentence(longRun);
    expect(result.complete).toBe(true);
    expect(result.firstSentence.length).toBeLessThanOrEqual(180);
    expect(result.firstSentence.length).toBeGreaterThan(0);
    expect(result.remainder.length).toBeGreaterThan(0);
  });
});

describe("remainderAfter accumulation invariant", () => {
  it("returns only the new tail when the prefix has already been spoken", () => {
    expect(remainderAfter("Hello there. How are you?", "Hello there.")).toBe(
      "How are you?",
    );
  });

  it("returns empty when nothing new is pending", () => {
    expect(remainderAfter("Hello there.", "Hello there.")).toBe("");
  });
});

describe("shouldCacheGeneratedSpeech", () => {
  it("caches short first/full clips", () => {
    expect(shouldCacheGeneratedSpeech("Got it.", "full")).toBe(true);
    expect(
      shouldCacheGeneratedSpeech("Okay, I am on it.", "first-sentence"),
    ).toBe(true);
  });

  it("caches complete long responses but not streaming remainders", () => {
    expect(
      shouldCacheGeneratedSpeech(
        "This sentence is deliberately longer than ten speech tokens for cache discipline.",
        "full",
      ),
    ).toBe(true);
    expect(shouldCacheGeneratedSpeech("short follow up", "remainder")).toBe(
      false,
    );
  });
});
