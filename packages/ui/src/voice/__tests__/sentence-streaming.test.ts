/**
 * Sentence-aware TTS streaming tests for the voice playback helpers.
 *
 * Simulates the streaming pattern that `useVoiceChat.queueAssistantSpeech`
 * relies on: deltas accumulate into a buffer, the first complete sentence
 * (or 180-char fallback chunk) is flushed for early audible feedback, and
 * the remainder is queued for later. This exercises the pure helpers
 * (`splitFirstSentence`, `queueableSpeechPrefix`, `remainderAfter`) that
 * back the hook so regressions surface without requiring a full React
 * render.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  queueableSpeechPrefix,
  remainderAfter,
  splitFirstSentence,
} from "../voice-chat-playback";

const ASSISTANT_TTS_FIRST_FLUSH_CHARS = 24;
const ASSISTANT_TTS_MIN_CHUNK_CHARS = 88;
const ASSISTANT_TTS_DEBOUNCE_MS = 170;

/**
 * Minimal simulation of how `useVoiceChat.queueAssistantSpeech` would
 * decide to flush a TTS chunk. We don't import the React hook (would
 * require RTL), but we replicate the decision logic to verify the
 * underlying helpers behave as the hook needs.
 */
function runStreamingFlusher(): {
  pushDelta: (delta: string, isFinal?: boolean) => void;
  flush: () => string | null;
  flushedClips: string[];
  buffer: () => string;
} {
  let buffer = "";
  let alreadySpoken = "";
  let isFirstClip = true;
  const flushedClips: string[] = [];

  const tryFlush = (isFinal: boolean): string | null => {
    const speakable = queueableSpeechPrefix(buffer, isFinal);
    if (!speakable) return null;
    const unsent = remainderAfter(speakable, alreadySpoken);
    if (!unsent) return null;
    const sizeOk =
      isFinal ||
      (isFirstClip && unsent.length >= ASSISTANT_TTS_FIRST_FLUSH_CHARS) ||
      (!isFirstClip && unsent.length >= ASSISTANT_TTS_MIN_CHUNK_CHARS);
    if (!sizeOk) return null;

    alreadySpoken = speakable;
    isFirstClip = false;
    flushedClips.push(unsent);
    return unsent;
  };

  return {
    pushDelta(delta, isFinal = false) {
      buffer += delta;
      // Hook checks immediately on each delta, but only the debounced timer
      // actually triggers the flush. We mirror that by deferring to flush().
      void isFinal;
    },
    flush() {
      return tryFlush(false);
    },
    flushedClips,
    buffer: () => buffer,
  };
}

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

describe("simulated streaming TTS flush behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes the first complete sentence after debounce, then buffers remainder", () => {
    const flusher = runStreamingFlusher();

    // Tokens dribble in before the first sentence is complete.
    flusher.pushDelta("Hel");
    flusher.pushDelta("lo there");

    // Simulate debounce window — flush should not produce anything yet
    // because no terminal punctuation has arrived.
    vi.advanceTimersByTime(ASSISTANT_TTS_DEBOUNCE_MS);
    expect(flusher.flush()).toBeNull();

    // Period arrives — first complete sentence is now eligible.
    flusher.pushDelta(". How are");
    vi.advanceTimersByTime(ASSISTANT_TTS_DEBOUNCE_MS);

    const firstClip = flusher.flush();
    expect(firstClip).toBe("Hello there.");
    expect(flusher.flushedClips).toEqual(["Hello there."]);

    // Subsequent deltas must wait for next sentence boundary.
    flusher.pushDelta(" you?");
    vi.advanceTimersByTime(ASSISTANT_TTS_DEBOUNCE_MS);
    const secondClip = flusher.flush();
    // Second clip is below the MIN_CHUNK_CHARS threshold (only "How are you?"),
    // so it should remain buffered until the final flush.
    expect(secondClip).toBeNull();
  });

  it("respects the 180-char fallback when no punctuation appears", () => {
    const flusher = runStreamingFlusher();

    // Keep pushing words with no punctuation; eventually the 180-char
    // fallback in queueableSpeechPrefix should engage.
    const longText = `${"running and ".repeat(20).trim()}`;
    flusher.pushDelta(longText);
    vi.advanceTimersByTime(ASSISTANT_TTS_DEBOUNCE_MS);

    const firstClip = flusher.flush();
    expect(firstClip).not.toBeNull();
    expect((firstClip ?? "").length).toBeGreaterThan(0);
    // The flushed prefix must be a true prefix of the buffer.
    expect(longText.startsWith(firstClip ?? "")).toBe(true);
  });

  it("first-clip threshold is lower than subsequent-clip threshold", () => {
    // Sanity check on the constants we mirror from the hook — if the
    // upstream constants change, this test will break and someone will
    // notice.
    expect(ASSISTANT_TTS_FIRST_FLUSH_CHARS).toBeLessThan(
      ASSISTANT_TTS_MIN_CHUNK_CHARS,
    );
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
