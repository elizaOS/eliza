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
  BargeInSignal,
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
  /**
   * Barge-in hard-stop: ring buffer drained, chunker reset, in-flight TTS
   * cancelled. The engine layer's `voiceStreamingArgs` separately threads
   * the `BargeInCancelToken.signal` (`bargeIn.onSignal` → `hard-stop`)
   * into `dispatcher.generate` so the LLM/drafter abort too.
   */
  onCancel?(): void;
  /** Provisional barge-in: a VAD voice hit while the agent is speaking paused TTS playback. */
  onTtsPause?(): void;
  /** Blip resolved the provisional barge-in — TTS playback resumed. */
  onTtsResume?(): void;
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
  /** True while a provisional barge-in (`pause-tts`) has paused playback. */
  private paused = false;

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
    // Legacy hard-stop hook (`bargeIn.onMicActive()` / `attach.onCancel`).
    this.bargeIn.attach({
      onCancel: () => this.handleBargeIn(),
    });
    // New signal stream: pause/resume on a provisional barge-in, hard-stop
    // when ASR confirms words. (`onMicActive()` also emits `hard-stop`, so
    // `handleBargeIn` fires from both the legacy `attach` and here — it's
    // idempotent.)
    this.bargeIn.onSignal((signal) => this.onBargeInSignal(signal));
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

  /** True while a provisional barge-in has paused TTS playback. */
  get ttsPaused(): boolean {
    return this.paused;
  }

  /**
   * Drop not-yet-spoken TTS without signalling a barge-in: drain the ring
   * buffer, reset the chunker, cancel in-flight synthesis. Used by the turn
   * controller when a speculative response is invalidated (speech resumed) —
   * the speculative TTS was streamed off a stale partial transcript, so it
   * must go, but this is not a user barge-in (`onCancel` is NOT fired).
   */
  cancelPendingTts(): void {
    this.paused = false;
    this.ringBuffer.drain();
    this.chunker.reset();
    for (const inflight of this.inFlight.values()) {
      inflight.cancelSignal.cancelled = true;
    }
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
    // When TTS is paused by a provisional barge-in, keep the synthesized
    // PCM in the ring buffer but DON'T hand it to the sink yet — `resume-tts`
    // flushes it; `hard-stop` drains it. (We still mark it "played" for the
    // rollback queue: once it's committed past the chunker it can't be
    // un-synthesized — only un-spoken.)
    if (!this.paused) {
      this.ringBuffer.flushToSink();
    }
    this.rollback.markPlayed(chunk.phraseId);
    this.events.onAudio?.(chunk);
  }

  private onBargeInSignal(signal: BargeInSignal): void {
    switch (signal.type) {
      case "pause-tts": {
        if (!this.paused) {
          this.paused = true;
          this.events.onTtsPause?.();
        }
        break;
      }
      case "resume-tts": {
        if (this.paused) {
          this.paused = false;
          // Hand whatever was buffered during the pause to the sink now.
          if (this.ringBuffer.size() > 0) this.ringBuffer.flushToSink();
          this.events.onTtsResume?.();
        }
        break;
      }
      case "hard-stop":
        // Handled by the legacy `attach.onCancel` hook registered in the
        // constructor — `BargeInController.hardStop()` fires both the
        // `attach` listeners and `onSignal(hard-stop)`, so doing the
        // ring-buffer drain again here would double-fire `onCancel`. The
        // engine layer subscribes to `onSignal(hard-stop)` separately to
        // thread `signal.token.signal` into `dispatcher.generate`.
        break;
    }
  }

  private handleBargeIn(): void {
    this.paused = false;
    this.ringBuffer.drain();
    this.chunker.reset();
    for (const inflight of this.inFlight.values()) {
      inflight.cancelSignal.cancelled = true;
    }
    this.events.onCancel?.();
  }
}
