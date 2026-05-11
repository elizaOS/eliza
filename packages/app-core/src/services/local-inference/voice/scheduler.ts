import { BargeInController } from "./barge-in";
import type { PhonemeTokenizer } from "./phoneme-tokenizer";
import { PhraseCache } from "./phrase-cache";
import { PhraseChunker } from "./phrase-chunker";
import { InMemoryAudioSink, PcmRingBuffer } from "./ring-buffer";
import { RollbackQueue } from "./rollback-queue";
import type {
  AcceptedToken,
  AudioChunk,
  AudioSink,
  OmniVoiceBackend,
  Phrase,
  RejectedTokenRange,
  SchedulerConfig,
  SpeakerPreset,
  TextToken,
} from "./types";

export interface SchedulerEvents {
  onPhrase?(phrase: Phrase): void;
  onRollback?(phraseId: number, range: RejectedTokenRange): void;
  onAudio?(chunk: AudioChunk): void;
  onCancel?(): void;
}

export interface SchedulerDeps {
  backend: OmniVoiceBackend;
  sink?: AudioSink;
  phraseCache?: PhraseCache;
  /** Optional. Required only when `config.chunkerConfig.chunkOn ===
   *  'phoneme-stream'`. Pass a real tokenizer in production; tests may
   *  pass `CharacterPhonemeStub`. */
  phonemeTokenizer?: PhonemeTokenizer;
}

interface InFlight {
  phrase: Phrase;
  cancelSignal: { cancelled: boolean };
  done: Promise<void>;
}

const DEFAULT_MAX_IN_FLIGHT_PHRASES = 4;

export class VoiceScheduler {
  readonly chunker: PhraseChunker;
  readonly rollback = new RollbackQueue();
  readonly bargeIn = new BargeInController();
  readonly ringBuffer: PcmRingBuffer;
  readonly sink: AudioSink;
  readonly preset: SpeakerPreset;
  private readonly backend: OmniVoiceBackend;
  private readonly phraseCache: PhraseCache;
  private readonly events: SchedulerEvents;
  private readonly inFlight = new Map<number, InFlight>();
  private readonly maxInFlight: number;
  private kernelTicks = 0;
  private nextStandalonePhraseId = -1;

  constructor(
    config: SchedulerConfig,
    deps: SchedulerDeps,
    events: SchedulerEvents = {},
  ) {
    this.chunker = new PhraseChunker(
      config.chunkerConfig,
      deps.phonemeTokenizer ?? null,
    );
    this.preset = config.preset;
    this.backend = deps.backend;
    this.phraseCache = deps.phraseCache ?? new PhraseCache();
    this.sink = deps.sink ?? new InMemoryAudioSink();
    this.ringBuffer = new PcmRingBuffer(
      config.ringBufferCapacity,
      config.sampleRate,
      this.sink,
    );
    this.events = events;
    this.maxInFlight = Math.max(
      1,
      config.maxInFlightPhrases ?? DEFAULT_MAX_IN_FLIGHT_PHRASES,
    );
    this.bargeIn.attach({
      onCancel: () => this.handleBargeIn(),
    });
  }

  async accept(token: TextToken, acceptedAt = Date.now()): Promise<void> {
    const acc: AcceptedToken = { ...token, acceptedAt };
    const phrase = this.chunker.push(acc);
    if (phrase) {
      await this.dispatchPhrase(phrase);
    }
  }

  async reject(range: RejectedTokenRange): Promise<void> {
    // Drop draft tokens still sitting in the chunker's buffer (not yet
    // packed into a phrase) so the verifier's correction is not glued
    // onto stale text.
    this.chunker.dropPendingFrom(range.fromIndex);
    const events = this.rollback.onRejected(range);
    for (const ev of events) {
      const inflight = this.inFlight.get(ev.phraseId);
      if (inflight) {
        inflight.cancelSignal.cancelled = true;
      }
      this.rollback.drop(ev.phraseId);
      this.events.onRollback?.(ev.phraseId, range);
    }
  }

  async flushPending(): Promise<void> {
    const tail = this.chunker.flushPending();
    if (tail) {
      await this.dispatchPhrase(tail);
    }
  }

  async waitIdle(): Promise<void> {
    const all = Array.from(this.inFlight.values()).map((i) => i.done);
    await Promise.all(all);
  }

  async synthesizeText(text: string): Promise<AudioChunk> {
    const phrase: Phrase = {
      id: this.nextStandalonePhraseId--,
      text,
      fromIndex: 0,
      toIndex: 0,
      terminator: "max-cap",
    };

    const cached = this.phraseCache.get(text);
    if (cached) {
      return {
        phraseId: phrase.id,
        fromIndex: phrase.fromIndex,
        toIndex: phrase.toIndex,
        pcm: cached.pcm,
        sampleRate: cached.sampleRate,
      };
    }

    const cancelSignal = { cancelled: false };
    const detach = this.bargeIn.attach({
      onCancel: () => {
        cancelSignal.cancelled = true;
      },
    });
    try {
      const chunk = await this.backend.synthesize({
        phrase,
        preset: this.preset,
        cancelSignal,
        onKernelTick: () => this.tickKernel(),
      });
      if (cancelSignal.cancelled) {
        throw new Error("[voice-scheduler] synthesis cancelled by barge-in");
      }
      this.phraseCache.put({
        text,
        pcm: chunk.pcm,
        sampleRate: chunk.sampleRate,
      });
      return chunk;
    } finally {
      detach();
    }
  }

  async prewarmPhrases(
    texts: ReadonlyArray<string>,
    opts: { concurrency?: number } = {},
  ): Promise<{ warmed: number; cached: number }> {
    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
    let warmed = 0;
    let cached = 0;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        if (index >= texts.length) return;
        const text = texts[index]?.trim();
        if (!text) continue;
        if (this.phraseCache.has(text)) {
          cached++;
          continue;
        }
        const phrase: Phrase = {
          id: this.nextStandalonePhraseId--,
          text,
          fromIndex: 0,
          toIndex: 0,
          terminator: "max-cap",
        };
        const chunk = await this.backend.synthesize({
          phrase,
          preset: this.preset,
          cancelSignal: { cancelled: false },
          onKernelTick: () => this.tickKernel(),
        });
        this.phraseCache.put({
          text,
          pcm: chunk.pcm,
          sampleRate: chunk.sampleRate,
        });
        warmed++;
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, texts.length) }, () =>
        worker(),
      ),
    );
    return { warmed, cached };
  }

  tickKernel(): void {
    this.kernelTicks++;
  }

  kernelTickCount(): number {
    return this.kernelTicks;
  }

  private async dispatchPhrase(phrase: Phrase): Promise<void> {
    this.rollback.track(phrase);
    this.events.onPhrase?.(phrase);

    const cached = this.phraseCache.get(phrase.text);
    if (cached) {
      const chunk: AudioChunk = {
        phraseId: phrase.id,
        fromIndex: phrase.fromIndex,
        toIndex: phrase.toIndex,
        pcm: cached.pcm,
        sampleRate: cached.sampleRate,
      };
      this.commitAudio(chunk);
      return;
    }

    if (this.inFlight.size >= this.maxInFlight) {
      const oldest = this.inFlight.values().next().value;
      if (oldest) {
        await oldest.done;
      }
    }

    const cancelSignal = { cancelled: false };
    const done = (async () => {
      try {
        this.rollback.markSynthesizing(phrase.id);
        const chunk = await this.backend.synthesize({
          phrase,
          preset: this.preset,
          cancelSignal,
          onKernelTick: () => this.tickKernel(),
        });
        if (cancelSignal.cancelled) {
          return;
        }
        if (!this.rollback.snapshot().some((e) => e.phrase.id === phrase.id)) {
          return;
        }
        this.phraseCache.put({
          text: phrase.text,
          pcm: chunk.pcm,
          sampleRate: chunk.sampleRate,
        });
        this.commitAudio(chunk);
      } finally {
        this.inFlight.delete(phrase.id);
      }
    })();

    this.inFlight.set(phrase.id, { phrase, cancelSignal, done });
  }

  private commitAudio(chunk: AudioChunk): void {
    this.rollback.markRingBuffered(chunk.phraseId);
    this.ringBuffer.write(chunk.pcm);
    this.ringBuffer.flushToSink();
    this.rollback.markPlayed(chunk.phraseId);
    this.events.onAudio?.(chunk);
  }

  private handleBargeIn(): void {
    this.ringBuffer.drain();
    this.chunker.reset();
    for (const inflight of this.inFlight.values()) {
      inflight.cancelSignal.cancelled = true;
    }
    this.events.onCancel?.();
  }
}
