/** Exercises real phrase chunking, complete stream delivery, TTS completion and watchdog behavior. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { PhraseChunkedTts, speakStreamingText } from "./phrase-chunked-tts";

// PhraseChunker is loaded lazily from @elizaos/plugin-local-inference/services
// to avoid a static boundary violation. Pre-warm it before the first test.
beforeAll(async () => {
  await PhraseChunkedTts.load();
});

function makeRecordingTts() {
  const calls: { text: string }[] = [];
  const tts = async (text: string): Promise<string> => {
    calls.push({ text });
    return `audio:${text}`;
  };
  return { tts, calls };
}

describe("PhraseChunkedTts", () => {
  it("emits the first phrase as soon as the first sentence-ending punctuation arrives", async () => {
    const { tts, calls } = makeRecordingTts();
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
    const { tts, calls } = makeRecordingTts();
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
    const { tts, calls } = makeRecordingTts();
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
    const { tts, calls } = makeRecordingTts();
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
    const { tts, calls } = makeRecordingTts();
    const pipe = new PhraseChunkedTts(tts, {
      onPhraseEmit: (p) => {
        // The TTS call must not have started yet at this synchronous hook.
        expect(calls).toHaveLength(0);
        seen.push(p.text);
      },
    });
    pipe.push("Phrase one.");
    expect(seen).toEqual(["Phrase one."]);
    await pipe.finish();
  });

  it("delivers each completed TTS result while another phrase is still pending", async () => {
    const alpha = Promise.withResolvers<string>();
    const betaDelivered = Promise.withResolvers<void>();
    const results: string[] = [];
    const pipe = new PhraseChunkedTts(
      (text) => (text === "Alpha." ? alpha.promise : "BETA."),
      {
        onAudio: (phrase, audio) => {
          results.push(`${phrase.text}=${audio}`);
          if (phrase.text === "Beta.") betaDelivered.resolve();
        },
      },
    );
    pipe.push("Alpha.");
    pipe.push("Beta.");
    const finished = pipe.finish();
    try {
      await betaDelivered.promise;
      expect(results).toEqual(["Beta.=BETA."]);
    } finally {
      alpha.resolve("ALPHA.");
      await finished;
    }
    expect(results).toEqual(["Beta.=BETA.", "Alpha.=ALPHA."]);
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
    const { tts } = makeRecordingTts();
    const pipe = new PhraseChunkedTts(tts);
    pipe.push("hello.");
    await pipe.finish();
    expect(() => pipe.push("more")).toThrow();
  });

  it("force-flushes a stalled phrase via the time-budget watchdog", async () => {
    // Use a virtual clock so the test is deterministic (no real setTimeout
    // delivery jitter). The pipe and the recording-TTS both read from the
    // same monotonic counter, advanced explicitly.
    let now = 0;
    const clock = () => now;
    const { tts, calls } = makeRecordingTts();
    const pipe = new PhraseChunkedTts(tts, {
      chunker: {
        chunkOn: "punctuation",
        maxAccumulationMs: 40,
      },
      clock,
    });

    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      // No punctuation, no max-token cap hit: only the time-budget can flush.
      pipe.push("stalled words without a terminator");
      // Advance virtual time past the 40ms budget and run any scheduled
      // timers; the watchdog setTimeout(40) should fire and the queued
      // microtask should dispatch the phrase to TTS.
      now = 60;
      await vi.advanceTimersByTimeAsync(60);
      // Drain microtasks (dispatchPhrase chains Promise.resolve().then(...)).
      await Promise.resolve();
      await Promise.resolve();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.text).toBe("stalled words without a terminator");
    } finally {
      vi.useRealTimers();
    }

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

  it("respects an explicit sentenceTerminators set (period-only mode)", async () => {
    const { tts, calls } = makeRecordingTts();
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
    const { tts, calls } = makeRecordingTts();
    const pipe = new PhraseChunkedTts(tts);
    const input = "One two three. Four five six! Seven, eight; nine: ten?";
    for (const ch of input) pipe.push(ch);
    await pipe.finish();
    expect(calls.map((c) => c.text).join("")).toBe(input);
  });
});
