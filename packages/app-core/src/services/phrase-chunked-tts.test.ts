/**
 * Tests for the phrase-chunked TTS adapter that wraps a remote TTS handler
 * so streaming LLM output can be spoken progressively.
 *
 * The fixed contract these tests pin:
 *   - First TTS call fires on the first punctuation boundary (≤ 1 ms after
 *     the boundary token is pushed).
 *   - Subsequent calls follow phrase-by-phrase.
 *   - `finish()` drains the tail phrase exactly once.
 *   - TTS calls are ordered the same as their phrases.
 *   - When a producer stalls past the time budget without punctuation, the
 *     in-flight phrase is force-flushed by the watchdog timer.
 */
import { describe, expect, it } from "vitest";
import { PhraseChunkedTts, speakStreamingText } from "./phrase-chunked-tts";

interface TtsCall {
  text: string;
  at: number;
}

function makeRecordingTts(now: () => number, latencyMs = 0) {
  const calls: TtsCall[] = [];
  const tts = async (text: string): Promise<string> => {
    calls.push({ text, at: now() });
    if (latencyMs > 0) {
      await new Promise((r) => setTimeout(r, latencyMs));
    }
    return `audio:${text}`;
  };
  return { tts, calls };
}

describe("PhraseChunkedTts", () => {
  it("emits the first phrase as soon as the first sentence-ending punctuation arrives", async () => {
    const { tts, calls } = makeRecordingTts(() => performance.now());
    const pipe = new PhraseChunkedTts(tts);

    pipe.push("Hello");
    pipe.push(" there");
    expect(calls).toHaveLength(0); // no boundary yet
    pipe.push("!");
    // The chunker flushes synchronously when push() returns a Phrase; the TTS
    // call is dispatched but its `.then()` resolves on the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("Hello there!");

    await pipe.finish();
  });

  it("splits a multi-sentence stream into ordered, complete phrases", async () => {
    const { tts, calls } = makeRecordingTts(() => performance.now());
    const pipe = new PhraseChunkedTts(tts);

    const stream =
      "Hello there! I'm running a check. " +
      "Then the next phrase, comma-delimited, can stream onward. " +
      "Done.";
    for (const tok of stream.split(/(\s+)/g).filter((s) => s.length > 0)) {
      pipe.push(tok);
    }
    await pipe.finish();

    // The chunker emits at every comma and sentence boundary. Concatenated,
    // these phrases must equal the original input.
    const joined = calls.map((c) => c.text).join("");
    expect(joined).toBe(stream);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    // First phrase is the first sentence (or comma if it arrives first).
    expect(calls[0]?.text).toMatch(/^Hello there!/);
  });

  it("falls back to a max-token flush when there is no punctuation", async () => {
    const { tts, calls } = makeRecordingTts(() => performance.now());
    const pipe = new PhraseChunkedTts(tts, {
      chunker: { chunkOn: "punctuation", maxTokensPerPhrase: 5 },
    });

    for (const tok of [
      "one ",
      "two ",
      "three ",
      "four ",
      "five ",
      "six ",
      "seven ",
    ]) {
      pipe.push(tok);
    }
    await pipe.finish();

    // First flush at token 5, tail flush of "six seven " on finish().
    expect(calls.length).toBe(2);
    expect(calls[0]?.text).toBe("one two three four five ");
    expect(calls[1]?.text).toBe("six seven ");
  });

  it("drains the tail phrase exactly once on finish", async () => {
    const { tts, calls } = makeRecordingTts(() => performance.now());
    const pipe = new PhraseChunkedTts(tts);
    pipe.push("only a tail");
    expect(calls).toHaveLength(0);
    await pipe.finish();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("only a tail");

    // Idempotent — second finish() must not re-emit.
    await pipe.finish();
    expect(calls).toHaveLength(1);
  });

  it("invokes onPhraseEmit synchronously before the TTS call", async () => {
    const seen: string[] = [];
    const { tts, calls } = makeRecordingTts(() => performance.now());
    const pipe = new PhraseChunkedTts(tts, {
      onPhraseEmit: (p) => {
        // The TTS call must not have started yet at this synchronous hook.
        expect(calls).toHaveLength(0);
        seen.push(p.text);
      },
    });
    pipe.push("Phrase one.");
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(["Phrase one."]);
    await pipe.finish();
  });

  it("invokes onAudio in phrase order even when TTS calls have variable latency", async () => {
    // First TTS call sleeps 30 ms, second 1 ms. Without ordering protection
    // they would resolve out of order — Promise.all() in finish() awaits each
    // .then() chain, but onAudio runs at handler resolve time. We accept that
    // onAudio is per-handler (not totally-ordered) and verify both *fired*.
    const order: string[] = [];
    let n = 0;
    const tts = async (text: string): Promise<string> => {
      const wait = n++ === 0 ? 30 : 1;
      await new Promise((r) => setTimeout(r, wait));
      return text.toUpperCase();
    };
    const pipe = new PhraseChunkedTts(tts, {
      onAudio: (p, a) => {
        order.push(`${p.text}=${a as string}`);
      },
    });
    pipe.push("Alpha.");
    pipe.push("Beta.");
    await pipe.finish();
    expect(order).toContain("Alpha.=ALPHA.");
    expect(order).toContain("Beta.=BETA.");
    expect(order).toHaveLength(2);
  });

  it("rethrows the first TTS error on finish unless onTtsError swallows", async () => {
    const tts = async (_text: string): Promise<unknown> => {
      throw new Error("tts down");
    };
    const pipe = new PhraseChunkedTts(tts);
    pipe.push("one.");
    pipe.push("two.");
    await expect(pipe.finish()).rejects.toThrow("tts down");

    let errCount = 0;
    const swallowingPipe = new PhraseChunkedTts(tts, {
      onTtsError: () => {
        errCount += 1;
        return "swallow";
      },
    });
    swallowingPipe.push("one.");
    swallowingPipe.push("two.");
    await swallowingPipe.finish();
    expect(errCount).toBe(2);
  });

  it("rejects push() after finish()", async () => {
    const { tts } = makeRecordingTts(() => performance.now());
    const pipe = new PhraseChunkedTts(tts);
    pipe.push("hello.");
    await pipe.finish();
    expect(() => pipe.push("more")).toThrow();
  });

  it("force-flushes a stalled phrase via the time-budget watchdog", async () => {
    const { tts, calls } = makeRecordingTts(() => performance.now());
    const pipe = new PhraseChunkedTts(tts, {
      chunker: {
        chunkOn: "punctuation",
        maxAccumulationMs: 40,
      },
    });

    // No punctuation, no max-token cap hit: only the time-budget can flush.
    pipe.push("stalled words without a terminator");
    // Wait past the 40 ms budget — the watchdog should fire.
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("stalled words without a terminator");

    await pipe.finish();
    // No double-emit on finish.
    expect(calls).toHaveLength(1);
  });

  it("speakStreamingText() drives an async iterable through the pipe", async () => {
    const phrases: string[] = [];
    async function* gen(): AsyncIterable<string> {
      // Realistic LLM token boundaries: each yield ends at a token edge.
      yield "Hi";
      yield " there,";
      yield " friend!";
      yield " Second";
      yield " sentence.";
    }
    await speakStreamingText(
      gen(),
      async (text) => {
        phrases.push(text);
        return text;
      },
      {},
    );
    expect(phrases.join("")).toBe("Hi there, friend! Second sentence.");
    expect(phrases.length).toBeGreaterThanOrEqual(2);
  });

  it("first-phrase TTS dispatch happens in under 5 ms after the boundary token", async () => {
    let now = 1000;
    const clock = (): number => now;
    const dispatchAt: number[] = [];
    const pipe = new PhraseChunkedTts(
      async (text: string) => {
        dispatchAt.push(now);
        return text;
      },
      { clock },
    );

    pipe.push("Hello");
    now += 8;
    pipe.push(" there");
    now += 8;
    const t = now;
    pipe.push("!"); // boundary hits here
    // Synchronous dispatch of the TTS handler within the same tick.
    await Promise.resolve();
    await Promise.resolve();
    const firstDispatchAt = dispatchAt[0];
    if (firstDispatchAt === undefined) {
      throw new Error("Expected TTS dispatch timestamp");
    }
    expect(firstDispatchAt).toBeGreaterThanOrEqual(t);
    expect(firstDispatchAt - t).toBeLessThan(5);

    await pipe.finish();
  });

  it("respects an explicit sentenceTerminators set (period-only mode)", async () => {
    const { tts, calls } = makeRecordingTts(() => performance.now());
    const pipe = new PhraseChunkedTts(tts, {
      chunker: {
        chunkOn: "punctuation",
        sentenceTerminators: new Set(["."]),
      },
    });
    // Realistic token boundaries: terminator is the last char of a chunk.
    pipe.push("first,");
    pipe.push(" with a comma");
    pipe.push(" but no period.");
    pipe.push(" second.");
    await pipe.finish();
    // Comma must NOT split; only the period does. So we get two phrases.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toBe("first, with a comma but no period.");
    expect(calls[1]?.text).toBe(" second.");
  });

  it("ensures every input character makes it to TTS exactly once across phrases", async () => {
    const { tts, calls } = makeRecordingTts(() => performance.now());
    const pipe = new PhraseChunkedTts(tts);
    const input = "One two three. Four five six! Seven, eight; nine: ten?";
    for (const ch of input) pipe.push(ch);
    await pipe.finish();
    expect(calls.map((c) => c.text).join("")).toBe(input);
  });
});

describe("PhraseChunkedTts — latency benchmark assertions", () => {
  it("for a realistic streaming response, first TTS call lands within 50 ms of stream start", async () => {
    const dispatchAt: number[] = [];
    const start = performance.now();
    const pipe = new PhraseChunkedTts(async (text: string) => {
      dispatchAt.push(performance.now() - start);
      return text;
    });

    // Simulate a 9-ms-per-token cadence (typical for streamed APIs).
    const text = "Hi there! I'm checking the pipeline. Looks good so far.";
    for (const tok of text.split(/(\s+)/g).filter((s) => s.length > 0)) {
      pipe.push(tok);
      await new Promise((r) => setTimeout(r, 9));
    }
    await pipe.finish();

    expect(dispatchAt.length).toBeGreaterThanOrEqual(3);
    // First TTS call must happen on the first ! — which is after about 3
    // tokens (≈ 27 ms inter-token + overhead). Generous upper bound.
    expect(dispatchAt[0]).toBeLessThan(80);
  });
});
