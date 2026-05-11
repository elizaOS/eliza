import { describe, expect, it } from "vitest";
import { BargeInController } from "./barge-in";
import {
  _resetStubWarnLatchForTests,
  CharacterPhonemeStub,
} from "./phoneme-tokenizer";
import { canonicalizePhraseText, PhraseCache } from "./phrase-cache";
import { chunkTokens, PhraseChunker } from "./phrase-chunker";
import { InMemoryAudioSink, PcmRingBuffer } from "./ring-buffer";
import { RollbackQueue } from "./rollback-queue";
import { VoiceScheduler } from "./scheduler";
import type {
  AudioChunk,
  OmniVoiceBackend,
  Phrase,
  SpeakerPreset,
  TextToken,
} from "./types";
import {
  readVoicePresetFile,
  VoicePresetFormatError,
  writeVoicePresetFile,
} from "./voice-preset-format";

function tok(index: number, text: string): TextToken {
  return { index, text };
}

function makePreset(): SpeakerPreset {
  const embedding = new Float32Array([0.1, 0.2, 0.3]);
  return {
    voiceId: "default",
    embedding,
    bytes: new Uint8Array(embedding.buffer.slice(0)),
  };
}

class StubBackend implements OmniVoiceBackend {
  calls = 0;
  cancelObserved: number[] = [];
  delay = 0;
  samplesPerToken = 8;

  async synthesize(args: {
    phrase: Phrase;
    preset: SpeakerPreset;
    cancelSignal: { cancelled: boolean };
    onKernelTick?: () => void;
  }): Promise<AudioChunk> {
    this.calls++;
    const tokenCount = args.phrase.toIndex - args.phrase.fromIndex + 1;
    const len = Math.max(1, tokenCount * this.samplesPerToken);
    if (this.delay > 0) {
      await new Promise((r) => setTimeout(r, this.delay));
    }
    args.onKernelTick?.();
    if (args.cancelSignal.cancelled) {
      this.cancelObserved.push(args.phrase.id);
    }
    const pcm = new Float32Array(len);
    for (let i = 0; i < len; i++) pcm[i] = (args.phrase.id + 1) * 0.01;
    return {
      phraseId: args.phrase.id,
      fromIndex: args.phrase.fromIndex,
      toIndex: args.phrase.toIndex,
      pcm,
      sampleRate: 24000,
    };
  }
}

describe("PhraseChunker", () => {
  it("splits at sentence-final punctuation", () => {
    const tokens: TextToken[] = [
      tok(0, "Hello"),
      tok(1, " world"),
      tok(2, "."),
      tok(3, " How"),
      tok(4, " are"),
      tok(5, " you"),
      tok(6, "?"),
    ];
    const phrases = chunkTokens(tokens, { maxTokensPerPhrase: 100 });
    expect(phrases).toHaveLength(2);
    expect(phrases[0].text).toBe("Hello world.");
    expect(phrases[0].terminator).toBe("punctuation");
    expect(phrases[0].fromIndex).toBe(0);
    expect(phrases[0].toIndex).toBe(2);
    expect(phrases[1].text).toBe(" How are you?");
    expect(phrases[1].fromIndex).toBe(3);
    expect(phrases[1].toIndex).toBe(6);
  });

  it("splits at the max-token cap when no punctuation", () => {
    const tokens: TextToken[] = Array.from({ length: 7 }, (_, i) =>
      tok(i, `t${i} `),
    );
    const phrases = chunkTokens(tokens, { maxTokensPerPhrase: 3 });
    expect(phrases).toHaveLength(3);
    expect(phrases[0].terminator).toBe("max-cap");
    expect(phrases[0].fromIndex).toBe(0);
    expect(phrases[0].toIndex).toBe(2);
    expect(phrases[1].fromIndex).toBe(3);
    expect(phrases[1].toIndex).toBe(5);
    expect(phrases[2].fromIndex).toBe(6);
    expect(phrases[2].toIndex).toBe(6);
  });

  it("flushes pending tokens via flushPending()", () => {
    const chunker = new PhraseChunker({ maxTokensPerPhrase: 100 });
    chunker.push({ ...tok(0, "Hi"), acceptedAt: 0 });
    chunker.push({ ...tok(1, " there"), acceptedAt: 0 });
    const tail = chunker.flushPending();
    expect(tail).not.toBeNull();
    expect(tail?.text).toBe("Hi there");
    expect(tail?.terminator).toBe("max-cap");
  });
});

describe("RollbackQueue", () => {
  it("emits rollback events for in-flight phrases overlapping rejected range", () => {
    const q = new RollbackQueue();
    const phraseA: Phrase = {
      id: 0,
      text: "a.",
      fromIndex: 0,
      toIndex: 4,
      terminator: "punctuation",
    };
    const phraseB: Phrase = {
      id: 1,
      text: "b.",
      fromIndex: 5,
      toIndex: 9,
      terminator: "punctuation",
    };
    const phraseC: Phrase = {
      id: 2,
      text: "c.",
      fromIndex: 10,
      toIndex: 14,
      terminator: "punctuation",
    };
    q.track(phraseA);
    q.track(phraseB);
    q.track(phraseC);
    q.markPlayed(phraseA.id);
    q.markRingBuffered(phraseB.id);
    q.markSynthesizing(phraseC.id);

    const events = q.onRejected({ fromIndex: 7, toIndex: 12 });
    const ids = events.map((e) => e.phraseId).sort();
    expect(ids).toEqual([1, 2]);
  });

  it("does not roll back already-played phrases", () => {
    const q = new RollbackQueue();
    const p: Phrase = {
      id: 0,
      text: "x",
      fromIndex: 0,
      toIndex: 3,
      terminator: "max-cap",
    };
    q.track(p);
    q.markPlayed(p.id);
    expect(q.onRejected({ fromIndex: 1, toIndex: 2 })).toEqual([]);
  });
});

describe("BargeInController", () => {
  it("flips cancel signal and notifies listeners on mic activity", () => {
    const c = new BargeInController();
    let count = 0;
    c.attach({ onCancel: () => count++ });
    expect(c.cancelSignal().cancelled).toBe(false);
    c.onMicActive();
    expect(c.cancelSignal().cancelled).toBe(true);
    expect(count).toBe(1);
  });

  it("reset issues a fresh cancel signal", () => {
    const c = new BargeInController();
    c.onMicActive();
    expect(c.cancelSignal().cancelled).toBe(true);
    c.reset();
    expect(c.cancelSignal().cancelled).toBe(false);
  });
});

describe("PcmRingBuffer", () => {
  it("writes samples and flushes them to the sink", () => {
    const sink = new InMemoryAudioSink();
    const rb = new PcmRingBuffer(8, 24000, sink);
    rb.write(new Float32Array([1, 2, 3, 4]));
    expect(rb.size()).toBe(4);
    rb.flushToSink();
    expect(rb.size()).toBe(0);
    expect(sink.totalWritten()).toBe(4);
  });

  it("wraps around when written past capacity (oldest dropped)", () => {
    const sink = new InMemoryAudioSink();
    const rb = new PcmRingBuffer(4, 24000, sink);
    rb.write(new Float32Array([1, 2, 3, 4, 5, 6]));
    expect(rb.size()).toBe(4);
    rb.flushToSink();
    expect(sink.chunks).toHaveLength(1);
    expect(Array.from(sink.chunks[0].pcm)).toEqual([3, 4, 5, 6]);
  });

  it("drain clears buffer without writing to sink", () => {
    const sink = new InMemoryAudioSink();
    const rb = new PcmRingBuffer(4, 24000, sink);
    rb.write(new Float32Array([1, 2, 3]));
    rb.drain();
    expect(rb.size()).toBe(0);
    expect(sink.totalWritten()).toBe(0);
  });
});

describe("PhraseCache", () => {
  it("canonicalizes whitespace and case", () => {
    expect(canonicalizePhraseText("  Hello   World  ")).toBe("hello world");
  });

  it("hits on canonical match", () => {
    const c = new PhraseCache();
    c.put({
      text: "Sure.",
      pcm: new Float32Array([0.5]),
      sampleRate: 24000,
    });
    expect(c.has("sure.")).toBe(true);
    expect(c.get("  SURE.  ")?.pcm[0]).toBe(0.5);
  });
});

describe("VoiceScheduler end-to-end", () => {
  it("synthesizes phrases via stubbed backend and emits PCM", async () => {
    const backend = new StubBackend();
    const sink = new InMemoryAudioSink();
    const phraseEvents: Phrase[] = [];
    const audioEvents: AudioChunk[] = [];
    const sched = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 10 },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend, sink },
      {
        onPhrase: (p) => phraseEvents.push(p),
        onAudio: (c) => audioEvents.push(c),
      },
    );

    const tokens: TextToken[] = [
      tok(0, "Hello"),
      tok(1, " world"),
      tok(2, "."),
      tok(3, " Bye"),
      tok(4, "."),
    ];
    for (const t of tokens) await sched.accept(t);
    await sched.waitIdle();

    expect(phraseEvents.map((p) => p.text)).toEqual(["Hello world.", " Bye."]);
    expect(audioEvents).toHaveLength(2);
    expect(backend.calls).toBe(2);
    expect(sink.totalWritten()).toBeGreaterThan(0);
  });

  it("drops audio for phrases overlapping rejected token range", async () => {
    const backend = new StubBackend();
    backend.delay = 20;
    const sink = new InMemoryAudioSink();
    const rollbacks: number[] = [];
    const sched = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 10 },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend, sink },
      { onRollback: (id) => rollbacks.push(id) },
    );

    await sched.accept(tok(0, "First"));
    await sched.accept(tok(1, " phrase"));
    await sched.accept(tok(2, "."));
    await sched.accept(tok(3, " Second"));
    await sched.accept(tok(4, " phrase"));
    await sched.accept(tok(5, "."));

    await sched.reject({ fromIndex: 4, toIndex: 5 });
    await sched.waitIdle();

    expect(rollbacks).toContain(1);
    expect(rollbacks).not.toContain(0);
    expect(sink.chunks.length).toBe(1);
  });

  it("barge-in cancels in-flight synthesis at next kernel boundary", async () => {
    const backend = new StubBackend();
    backend.delay = 30;
    const sink = new InMemoryAudioSink();
    let cancelEmitted = 0;
    const sched = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 10 },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend, sink },
      { onCancel: () => cancelEmitted++ },
    );

    await sched.accept(tok(0, "Hello"));
    await sched.accept(tok(1, " there"));
    await sched.accept(tok(2, "."));

    const ticksBefore = sched.kernelTickCount();
    sched.bargeIn.onMicActive();
    await sched.waitIdle();
    const ticksAfter = sched.kernelTickCount();

    expect(cancelEmitted).toBe(1);
    expect(sched.bargeIn.cancelSignal().cancelled).toBe(true);
    expect(ticksAfter - ticksBefore).toBeLessThanOrEqual(1);
    expect(sink.totalWritten()).toBe(0);
  });

  it("drops audio for IPA-mode sub-phrase chunks overlapping rejected range", async () => {
    const backend = new StubBackend();
    backend.delay = 20;
    const sink = new InMemoryAudioSink();
    const tokenizer = new CharacterPhonemeStub();
    const rollbacks: number[] = [];
    const sched = new VoiceScheduler(
      {
        chunkerConfig: {
          maxTokensPerPhrase: 100,
          chunkOn: "phoneme-stream",
          phonemesPerChunk: 4,
        },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend, sink, phonemeTokenizer: tokenizer },
      { onRollback: (id) => rollbacks.push(id) },
    );

    // Each token is 4 chars => 4 phonemes => exactly one chunk per token.
    await sched.accept(tok(0, "abcd"));
    await sched.accept(tok(1, "efgh"));
    await sched.accept(tok(2, "ijkl"));

    // Reject token 1; chunk #1 (token range [1..1]) must roll back; #0 stays.
    await sched.reject({ fromIndex: 1, toIndex: 1 });
    await sched.waitIdle();

    expect(rollbacks).toContain(1);
    expect(rollbacks).not.toContain(0);
  });

  it("uses phrase cache for precomputed common utterances (no backend call)", async () => {
    const backend = new StubBackend();
    const sink = new InMemoryAudioSink();
    const phraseCache = new PhraseCache();
    phraseCache.put({
      text: "Sure.",
      pcm: new Float32Array([0.42, 0.42, 0.42]),
      sampleRate: 24000,
    });
    const sched = new VoiceScheduler(
      {
        chunkerConfig: { maxTokensPerPhrase: 10 },
        preset: makePreset(),
        ringBufferCapacity: 4096,
        sampleRate: 24000,
      },
      { backend, sink, phraseCache },
    );

    await sched.accept(tok(0, "Sure"));
    await sched.accept(tok(1, "."));
    await sched.waitIdle();

    expect(backend.calls).toBe(0);
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0].pcm).toHaveLength(3);
    for (const v of sink.chunks[0].pcm) {
      expect(v).toBeCloseTo(0.42, 5);
    }
  });
});

describe("VoicePresetFormat", () => {
  it("round-trips a synthetic preset (embedding + phrase cache seed)", () => {
    const embedding = new Float32Array([0.1, -0.2, 0.3, 0.4]);
    const phrases = [
      {
        text: "sure.",
        sampleRate: 24000,
        pcm: new Float32Array([0.1, 0.2, 0.3]),
      },
      {
        text: "one moment.",
        sampleRate: 24000,
        pcm: new Float32Array([0.4, 0.5, 0.6, 0.7]),
      },
    ];
    const blob = writeVoicePresetFile({ embedding, phrases });
    const parsed = readVoicePresetFile(blob);
    expect(parsed.version).toBe(1);
    expect(parsed.embedding.length).toBe(embedding.length);
    for (let i = 0; i < embedding.length; i++) {
      expect(parsed.embedding[i]).toBeCloseTo(embedding[i], 5);
    }
    expect(parsed.phrases).toHaveLength(2);
    expect(parsed.phrases[0].text).toBe("sure.");
    expect(parsed.phrases[0].sampleRate).toBe(24000);
    expect(parsed.phrases[0].pcm.length).toBe(3);
    expect(parsed.phrases[0].pcm[0]).toBeCloseTo(0.1, 5);
    expect(parsed.phrases[0].pcm[1]).toBeCloseTo(0.2, 5);
    expect(parsed.phrases[0].pcm[2]).toBeCloseTo(0.3, 5);
    expect(parsed.phrases[1].text).toBe("one moment.");
    expect(parsed.phrases[1].pcm.length).toBe(4);
  });

  it("round-trips an empty phrase cache seed (N=0)", () => {
    const embedding = new Float32Array([1, 2, 3]);
    const blob = writeVoicePresetFile({ embedding, phrases: [] });
    const parsed = readVoicePresetFile(blob);
    expect(parsed.phrases).toHaveLength(0);
    expect(parsed.embedding.length).toBe(3);
    expect(parsed.embedding[0]).toBeCloseTo(1, 5);
    expect(parsed.embedding[1]).toBeCloseTo(2, 5);
    expect(parsed.embedding[2]).toBeCloseTo(3, 5);
  });

  it("rejects bad magic with VoicePresetFormatError", () => {
    const bytes = new Uint8Array(24);
    expect(() => readVoicePresetFile(bytes)).toThrow(VoicePresetFormatError);
  });

  it("rejects truncated header", () => {
    const bytes = new Uint8Array(8);
    expect(() => readVoicePresetFile(bytes)).toThrow(VoicePresetFormatError);
  });

  it("rejects unsupported version", () => {
    const blob = writeVoicePresetFile({
      embedding: new Float32Array([0]),
      phrases: [],
    });
    new DataView(blob.buffer).setUint32(4, 999, true);
    expect(() => readVoicePresetFile(blob)).toThrow(VoicePresetFormatError);
  });
});

describe("PhraseCache.seed", () => {
  it("pre-populates the cache from voice-preset seed entries", () => {
    const cache = new PhraseCache();
    cache.seed([
      {
        text: "sure.",
        pcm: new Float32Array([0.1]),
        sampleRate: 24000,
      },
      {
        text: "one moment.",
        pcm: new Float32Array([0.2]),
        sampleRate: 24000,
      },
    ]);
    expect(cache.size()).toBe(2);
    expect(cache.has("Sure.")).toBe(true);
    expect(cache.get("ONE MOMENT.")?.pcm[0]).toBeCloseTo(0.2, 5);
  });
});

describe("PhraseChunker IPA mode", () => {
  it("punctuation mode (default) is unchanged when no tokenizer is passed", () => {
    const tokens: TextToken[] = [
      tok(0, "Hello"),
      tok(1, " world"),
      tok(2, "."),
    ];
    const phrases = chunkTokens(tokens, { maxTokensPerPhrase: 100 });
    expect(phrases).toHaveLength(1);
    expect(phrases[0].terminator).toBe("punctuation");
    expect(phrases[0].text).toBe("Hello world.");
  });

  it("phoneme-stream mode emits sub-phrase chunks at phoneme boundaries", () => {
    _resetStubWarnLatchForTests();
    const tokenizer = new CharacterPhonemeStub();
    // 'abcde' = 5 phonemes, 'fgh' = 3 phonemes, 'ij' = 2 phonemes.
    // Cumulative phoneme count after each: 5, 8, 10.
    // With phonemesPerChunk=4: token 0 alone => 5 ≥ 4 => chunk #0 (token 0).
    // Then token 1 (3) + token 2 (2) = 5 ≥ 4 after token 2 => chunk #1.
    const tokens: TextToken[] = [tok(0, "abcde"), tok(1, "fgh"), tok(2, "ij")];
    const phrases = chunkTokens(
      tokens,
      {
        maxTokensPerPhrase: 100,
        chunkOn: "phoneme-stream",
        phonemesPerChunk: 4,
      },
      0,
      tokenizer,
    );
    expect(phrases).toHaveLength(2);
    expect(phrases[0].terminator).toBe("phoneme-stream");
    expect(phrases[0].fromIndex).toBe(0);
    expect(phrases[0].toIndex).toBe(0);
    expect(phrases[0].text).toBe("abcde");
    expect(phrases[1].fromIndex).toBe(1);
    expect(phrases[1].toIndex).toBe(2);
    expect(phrases[1].text).toBe("fghij");
  });

  it("phoneme-stream mode still respects punctuation as a hard boundary", () => {
    const tokenizer = new CharacterPhonemeStub();
    const tokens: TextToken[] = [tok(0, "hi"), tok(1, ".")];
    const phrases = chunkTokens(
      tokens,
      {
        maxTokensPerPhrase: 100,
        chunkOn: "phoneme-stream",
        phonemesPerChunk: 16,
      },
      0,
      tokenizer,
    );
    expect(phrases).toHaveLength(1);
    expect(phrases[0].terminator).toBe("punctuation");
  });

  it("throws if phoneme-stream mode is selected without a tokenizer", () => {
    expect(() =>
      chunkTokens(
        [tok(0, "x")],
        { maxTokensPerPhrase: 100, chunkOn: "phoneme-stream" },
        0,
        null,
      ),
    ).toThrow();
  });

  it("CharacterPhonemeStub flags itself as a stub", () => {
    const t = new CharacterPhonemeStub();
    expect(t.isStub).toBe(true);
    expect(t.name).toBe("CharacterPhonemeStub");
  });
});
