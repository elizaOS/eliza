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
  StreamingTtsBackend,
  TextToken,
  TtsPcmChunk,
  VoiceAudioSource,
  VoiceSchedulerPhraseTelemetry,
  VoiceSchedulerTelemetryEvent,
  VoiceSchedulerTelemetryListener,
  VoiceTtsCancelReason,
} from "./types";

/**
 * T2 — per-phrase TTS chunk-size telemetry, emitted once per
 * `synthesizePhraseStream` call when `SchedulerEvents.onChunkMetrics` is
 * wired. `chunks` is the in-arrival-order distribution of streamed PCM
 * chunks (size in PCM bytes assuming Float32 samples, duration in ms
 * derived from samples / sampleRate). Used to debug T1-class chunk-size
 * pathologies and to verify T3 time-budget effects.
 */
export interface TtsPhraseChunkMetrics {
  phraseId: number;
  /** Order-preserving list of per-chunk sizes. Empty when no chunks landed. */
  chunks: ReadonlyArray<{
    chunkBytes: number;
    chunkDurationMs: number;
  }>;
  /** Sum of chunk durations in ms. */
  totalDurationMs: number;
  /** Sum of chunk bytes. */
  totalBytes: number;
  /** Whether the phrase synthesis was cancelled mid-stream. */
  cancelled: boolean;
}

export type TtsChunkMetricsListener = (metrics: TtsPhraseChunkMetrics) => void;

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
  /** Structured scheduler telemetry for latency, cache, rollback, and barge-in metrics. */
  onTelemetry?: VoiceSchedulerTelemetryListener;
  /**
   * T2 — per-phrase TTS chunk-size distribution. Optional; when set, the
   * scheduler emits one summary per streamed phrase synthesis (success or
   * cancelled). Lets test harnesses and metrics consumers verify T1/T3
   * effects without scraping the audio bus.
   */
  onChunkMetrics?: TtsChunkMetricsListener;
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

interface NativeCancelableTtsBackend {
  cancelTts(): void;
}

const DEFAULT_MAX_IN_FLIGHT_PHRASES = 4;

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function phraseTelemetry(phrase: Phrase): VoiceSchedulerPhraseTelemetry {
  return {
    id: phrase.id,
    text: phrase.text,
    fromIndex: phrase.fromIndex,
    toIndex: phrase.toIndex,
    terminator: phrase.terminator,
    tokenCount: Math.max(0, phrase.toIndex - phrase.fromIndex + 1),
    textBytes: new TextEncoder().encode(phrase.text).length,
  };
}

function isStreamingTtsBackend(
  backend: OmniVoiceBackend,
): backend is OmniVoiceBackend & StreamingTtsBackend {
  return (
    typeof (backend as Partial<StreamingTtsBackend>).synthesizeStream ===
    "function"
  );
}

function isNativeCancelableTtsBackend(
  backend: OmniVoiceBackend,
): backend is OmniVoiceBackend & NativeCancelableTtsBackend {
  return (
    typeof (backend as Partial<NativeCancelableTtsBackend>).cancelTts ===
    "function"
  );
}

function copyPcm(pcm: Float32Array): Float32Array {
  return new Float32Array(pcm);
}

function concatPcm(
  parts: ReadonlyArray<Float32Array>,
  total: number,
): Float32Array {
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

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
  private readonly sampleRate: number;
  private readonly inFlight = new Map<number, InFlight>();
  private readonly maxInFlight: number;
  private kernelTicks = 0;
  private nextStandalonePhraseId = -1;
  /** True while a provisional barge-in (`pause-tts`) has paused playback. */
  private paused = false;
  private agentSpeakingUntilMs = 0;
  private agentSpeakingTimer: ReturnType<typeof setTimeout> | null = null;
  private phraseFlushTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.sampleRate = config.sampleRate;
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
      this.clearPhraseFlushTimer();
      await this.dispatchPhrase(phrase);
      return;
    }
    this.armPhraseFlushTimer();
  }

  async reject(range: RejectedTokenRange): Promise<void> {
    // Drop draft tokens still sitting in the chunker's buffer (not yet
    // packed into a phrase) so the verifier's correction is not glued
    // onto stale text.
    this.chunker.dropPendingFrom(range.fromIndex);
    this.armPhraseFlushTimer();
    const events = this.rollback.onRejected(range);
    let cancelledStreamingInFlight = false;
    for (const ev of events) {
      const inflight = this.inFlight.get(ev.phraseId);
      if (inflight) {
        inflight.cancelSignal.cancelled = true;
        cancelledStreamingInFlight ||= isStreamingTtsBackend(this.backend);
        this.emitTtsCancel(inflight.phrase, "rollback");
      }
      this.rollback.drop(ev.phraseId);
      this.events.onRollback?.(ev.phraseId, range);
      this.emitTelemetry({
        type: "rollback",
        atMs: nowMs(),
        phraseId: ev.phraseId,
        range,
        reason: ev.reason,
      });
    }
    if (cancelledStreamingInFlight) {
      this.cancelNativeTts();
    }
  }

  async flushPending(): Promise<void> {
    this.clearPhraseFlushTimer();
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
      this.emitTelemetry({
        type: "phrase-cache-hit",
        atMs: nowMs(),
        phrase: phraseTelemetry(phrase),
      });
      this.emitTelemetry({
        type: "tts-first-audio",
        atMs: nowMs(),
        phrase: phraseTelemetry(phrase),
        source: "cache",
        samples: cached.pcm.length,
        sampleRate: cached.sampleRate,
      });
      return {
        phraseId: phrase.id,
        fromIndex: phrase.fromIndex,
        toIndex: phrase.toIndex,
        pcm: cached.pcm,
        sampleRate: cached.sampleRate,
      };
    }
    this.emitTelemetry({
      type: "phrase-cache-miss",
      atMs: nowMs(),
      phrase: phraseTelemetry(phrase),
    });

    const cancelSignal = { cancelled: false };
    const detach = this.bargeIn.attach({
      onCancel: () => {
        cancelSignal.cancelled = true;
      },
    });
    try {
      this.emitTelemetry({
        type: "tts-start",
        atMs: nowMs(),
        phrase: phraseTelemetry(phrase),
        inFlightPhrases: this.inFlight.size,
      });
      const chunk = await this.backend.synthesize({
        phrase,
        preset: this.preset,
        cancelSignal,
        onKernelTick: () => this.tickKernel(),
      });
      if (cancelSignal.cancelled) {
        this.emitTtsCancel(phrase, "synthesis-cancelled");
        throw new Error("[voice-scheduler] synthesis cancelled by barge-in");
      }
      this.emitTelemetry({
        type: "tts-first-audio",
        atMs: nowMs(),
        phrase: phraseTelemetry(phrase),
        source: "synthesis",
        samples: chunk.pcm.length,
        sampleRate: chunk.sampleRate,
      });
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
        const stored = this.phraseCache.put({
          text,
          pcm: chunk.pcm,
          sampleRate: chunk.sampleRate,
        });
        if (stored) warmed++;
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

  /**
   * Mark the agent as audibly speaking for the duration of audio handed to the
   * sink. This is the barge-in gate: VAD blips only pause/resume TTS while this
   * flag is true, and ASR-confirmed words hard-stop playback plus generation.
   */
  markAgentSpeakingForAudio(samples: number, sampleRate: number): void {
    if (samples <= 0 || sampleRate <= 0) return;
    const durationMs = (samples / sampleRate) * 1000;
    // A short guard absorbs sink scheduling jitter between tiny streaming chunks.
    this.agentSpeakingUntilMs = Math.max(
      this.agentSpeakingUntilMs,
      nowMs() + durationMs + 50,
    );
    this.bargeIn.setAgentSpeaking(true);
    this.armAgentSpeakingTimer();
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
    this.clearAgentSpeaking();
    this.clearPhraseFlushTimer();
    this.ringBuffer.drain();
    this.chunker.reset();
    for (const inflight of this.inFlight.values()) {
      inflight.cancelSignal.cancelled = true;
      this.emitTtsCancel(inflight.phrase, "pending-tts");
    }
    this.cancelNativeTts();
  }

  private async dispatchPhrase(phrase: Phrase): Promise<void> {
    this.rollback.track(phrase);
    this.events.onPhrase?.(phrase);
    this.emitTelemetry({
      type: "phrase-dispatch",
      atMs: nowMs(),
      phrase: phraseTelemetry(phrase),
      inFlightPhrases: this.inFlight.size,
    });

    const cached = this.phraseCache.get(phrase.text);
    if (cached) {
      this.emitTelemetry({
        type: "phrase-cache-hit",
        atMs: nowMs(),
        phrase: phraseTelemetry(phrase),
      });
      const chunk: AudioChunk = {
        phraseId: phrase.id,
        fromIndex: phrase.fromIndex,
        toIndex: phrase.toIndex,
        pcm: cached.pcm,
        sampleRate: cached.sampleRate,
      };
      this.commitAudio(chunk, phrase, "cache");
      return;
    }
    this.emitTelemetry({
      type: "phrase-cache-miss",
      atMs: nowMs(),
      phrase: phraseTelemetry(phrase),
    });

    if (this.inFlight.size >= this.maxInFlight) {
      const oldest = this.inFlight.values().next().value;
      if (oldest) {
        await oldest.done;
      }
    }

    const cancelSignal = { cancelled: false };
    let resolveDone!: () => void;
    let rejectDone!: (err: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    this.inFlight.set(phrase.id, { phrase, cancelSignal, done });
    void this.runPhraseSynthesis(phrase, cancelSignal).then(
      resolveDone,
      rejectDone,
    );
  }

  private async runPhraseSynthesis(
    phrase: Phrase,
    cancelSignal: { cancelled: boolean },
  ): Promise<void> {
    try {
      this.rollback.markSynthesizing(phrase.id);
      this.emitTelemetry({
        type: "tts-start",
        atMs: nowMs(),
        phrase: phraseTelemetry(phrase),
        inFlightPhrases: this.inFlight.size,
      });
      if (isStreamingTtsBackend(this.backend)) {
        const cancelled = await this.synthesizePhraseStream(
          phrase,
          cancelSignal,
        );
        if (cancelled || cancelSignal.cancelled) {
          this.emitTtsCancel(phrase, "synthesis-cancelled");
        }
        return;
      }
      const chunk = await this.backend.synthesize({
        phrase,
        preset: this.preset,
        cancelSignal,
        onKernelTick: () => this.tickKernel(),
      });
      if (cancelSignal.cancelled) {
        this.emitTtsCancel(phrase, "synthesis-cancelled");
        return;
      }
      if (!this.isPhraseTracked(phrase.id)) {
        return;
      }
      this.phraseCache.put({
        text: phrase.text,
        pcm: chunk.pcm,
        sampleRate: chunk.sampleRate,
      });
      this.commitAudio(chunk, phrase, "synthesis");
    } finally {
      this.inFlight.delete(phrase.id);
    }
  }

  private async synthesizePhraseStream(
    phrase: Phrase,
    cancelSignal: { cancelled: boolean },
  ): Promise<boolean> {
    const backend = this.backend;
    if (!isStreamingTtsBackend(backend)) return false;

    const parts: Float32Array[] = [];
    let totalSamples = 0;
    let sampleRate = 0;
    let firstAudio = true;
    // T2 — per-chunk size distribution. Float32 samples => 4 bytes/sample.
    const chunkSamples: Array<{ samples: number; sampleRate: number }> = [];
    const result = await backend.synthesizeStream({
      phrase,
      preset: this.preset,
      cancelSignal,
      onKernelTick: () => this.tickKernel(),
      onChunk: (chunk: TtsPcmChunk) => {
        if (cancelSignal.cancelled || !this.isPhraseTracked(phrase.id)) {
          return true;
        }
        if (chunk.isFinal || chunk.pcm.length === 0) {
          return cancelSignal.cancelled;
        }
        const pcm = copyPcm(chunk.pcm);
        parts.push(pcm);
        totalSamples += pcm.length;
        sampleRate = chunk.sampleRate;
        chunkSamples.push({
          samples: pcm.length,
          sampleRate: chunk.sampleRate,
        });
        this.commitAudio(
          {
            phraseId: phrase.id,
            fromIndex: phrase.fromIndex,
            toIndex: phrase.toIndex,
            pcm,
            sampleRate: chunk.sampleRate,
          },
          phrase,
          "synthesis",
          { emitFirstAudio: firstAudio, markPlayed: false },
        );
        firstAudio = false;
        return cancelSignal.cancelled;
      },
    });

    const cancelled = result.cancelled || cancelSignal.cancelled;
    if (!cancelled && this.isPhraseTracked(phrase.id)) {
      this.rollback.markPlayed(phrase.id);
      if (totalSamples > 0) {
        this.phraseCache.put({
          text: phrase.text,
          pcm: concatPcm(parts, totalSamples),
          sampleRate,
        });
      }
    }
    // T2 — fire the chunk-size telemetry callback. Done unconditionally so
    // a cancelled phrase still reports what it did stream (helps debug
    // barge-in latency). Float32 samples occupy 4 bytes each.
    if (this.events.onChunkMetrics) {
      const chunks = chunkSamples.map((c) => ({
        chunkBytes: c.samples * 4,
        chunkDurationMs:
          c.sampleRate > 0 ? (c.samples / c.sampleRate) * 1000 : 0,
      }));
      let totalDurationMs = 0;
      let totalBytes = 0;
      for (const c of chunks) {
        totalDurationMs += c.chunkDurationMs;
        totalBytes += c.chunkBytes;
      }
      this.events.onChunkMetrics({
        phraseId: phrase.id,
        chunks,
        totalDurationMs,
        totalBytes,
        cancelled,
      });
    }
    return cancelled;
  }

  private isPhraseTracked(phraseId: number): boolean {
    return this.rollback
      .snapshot()
      .some((entry) => entry.phrase.id === phraseId);
  }

  private cancelNativeTts(): void {
    if (isNativeCancelableTtsBackend(this.backend)) {
      this.backend.cancelTts();
    }
  }

  private commitAudio(
    chunk: AudioChunk,
    phrase: Phrase,
    source: VoiceAudioSource,
    opts: { emitFirstAudio?: boolean; markPlayed?: boolean } = {},
  ): void {
    if (opts.emitFirstAudio !== false) {
      this.emitTelemetry({
        type: "tts-first-audio",
        atMs: nowMs(),
        phrase: phraseTelemetry(phrase),
        source,
        samples: chunk.pcm.length,
        sampleRate: chunk.sampleRate,
      });
    }
    this.rollback.markRingBuffered(chunk.phraseId);
    this.ringBuffer.write(chunk.pcm);
    // When TTS is paused by a provisional barge-in, keep the synthesized
    // PCM in the ring buffer but DON'T hand it to the sink yet — `resume-tts`
    // flushes it; `hard-stop` drains it.
    let flushedSamples = 0;
    if (!this.paused) {
      flushedSamples = this.ringBuffer.flushToSink();
      this.markAgentSpeakingForAudio(flushedSamples, chunk.sampleRate);
    }
    if (opts.markPlayed !== false) {
      this.rollback.markPlayed(chunk.phraseId);
    }
    this.emitTelemetry({
      type: "audio-committed",
      atMs: nowMs(),
      phrase: phraseTelemetry(phrase),
      source,
      samples: chunk.pcm.length,
      sampleRate: chunk.sampleRate,
      flushedSamples,
      paused: this.paused,
      ringBufferSamples: this.ringBuffer.size(),
      sinkBufferedSamples: this.sink.bufferedSamples(),
    });
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
          if (this.ringBuffer.size() > 0) {
            const flushed = this.ringBuffer.flushToSink();
            this.markAgentSpeakingForAudio(flushed, this.sampleRate);
          }
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
    const ringBufferSamplesDrained = this.ringBuffer.size();
    const sinkBufferedSamplesDrained = this.sink.bufferedSamples();
    const wasPaused = this.paused;
    const inFlightPhrases = Array.from(this.inFlight.values());
    this.paused = false;
    this.clearAgentSpeaking();
    this.clearPhraseFlushTimer();
    this.ringBuffer.drain();
    this.chunker.reset();
    for (const inflight of inFlightPhrases) {
      inflight.cancelSignal.cancelled = true;
      this.emitTtsCancel(inflight.phrase, "barge-in");
    }
    this.cancelNativeTts();
    this.emitTelemetry({
      type: "barge-in",
      atMs: nowMs(),
      ringBufferSamplesDrained,
      sinkBufferedSamplesDrained,
      inFlightPhrasesCancelled: inFlightPhrases.length,
      wasPaused,
    });
    this.events.onCancel?.();
  }

  private emitTtsCancel(phrase: Phrase, reason: VoiceTtsCancelReason): void {
    this.emitTelemetry({
      type: "tts-cancel",
      atMs: nowMs(),
      phrase: phraseTelemetry(phrase),
      reason,
    });
  }

  private emitTelemetry(event: VoiceSchedulerTelemetryEvent): void {
    this.events.onTelemetry?.(event);
  }

  private armPhraseFlushTimer(): void {
    this.clearPhraseFlushTimer();
    const delayMs = this.chunker.msUntilTimeBudget();
    if (!Number.isFinite(delayMs)) return;
    this.phraseFlushTimer = setTimeout(() => {
      this.phraseFlushTimer = null;
      const phrase = this.chunker.flushIfTimeBudgetExceeded();
      if (!phrase) {
        this.armPhraseFlushTimer();
        return;
      }
      void this.dispatchPhrase(phrase).catch((err) => {
        setTimeout(() => {
          throw err;
        }, 0);
      });
    }, Math.max(0, delayMs));
  }

  private clearPhraseFlushTimer(): void {
    if (this.phraseFlushTimer) {
      clearTimeout(this.phraseFlushTimer);
      this.phraseFlushTimer = null;
    }
  }

  private armAgentSpeakingTimer(): void {
    if (this.agentSpeakingTimer) {
      clearTimeout(this.agentSpeakingTimer);
      this.agentSpeakingTimer = null;
    }
    const delayMs = Math.max(1, this.agentSpeakingUntilMs - nowMs());
    this.agentSpeakingTimer = setTimeout(() => {
      this.agentSpeakingTimer = null;
      if (nowMs() < this.agentSpeakingUntilMs) {
        this.armAgentSpeakingTimer();
        return;
      }
      this.agentSpeakingUntilMs = 0;
      if (this.ringBuffer.size() === 0) {
        this.bargeIn.setAgentSpeaking(false);
      }
    }, delayMs);
    const maybeUnref = this.agentSpeakingTimer as { unref?: () => void };
    maybeUnref.unref?.();
  }

  private clearAgentSpeaking(): void {
    this.agentSpeakingUntilMs = 0;
    if (this.agentSpeakingTimer) {
      clearTimeout(this.agentSpeakingTimer);
      this.agentSpeakingTimer = null;
    }
    this.bargeIn.setAgentSpeaking(false);
  }
}
