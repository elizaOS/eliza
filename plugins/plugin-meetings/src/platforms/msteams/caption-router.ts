/**
 * Caption-driven per-speaker audio routing for Microsoft Teams.
 *
 * Teams delivers ONE mixed remote audio stream. Live-caption authorship is
 * the diarization signal: captions only fire on real speech, so caption
 * author changes mark speaker boundaries. Audio chunks are held in a short
 * ring buffer to bridge the caption delay (~1–2 s); on a speaker change we
 * flush only the recent lookback window to the NEW speaker (older chunks are
 * stale silence from the inter-speaker gap), and on caption text growth we
 * flush the queue to the current speaker.
 *
 * Port of Vexa's in-page state machine
 * (msteams/recording.ts processCaptions, Apache-2.0), lifted into Node so it
 * is pure and unit-testable. The page side only ships RMS-gated 16 kHz PCM
 * chunks and caption/voice-level events over exposed bindings.
 */

import type { MeetingAudioSink } from "../../types.js";

export interface TeamsCaptionRouterOptions {
  sink: MeetingAudioSink;
  /** Bot display name — its own captions/audio are never routed. */
  botName: string;
  /** Ring buffer horizon (default 10 000 ms). */
  maxQueueAgeMs?: number;
  /** Speaker-change lookback window (default 2 000 ms). */
  lookbackMs?: number;
  /** Caption text growth below this many chars is an ASR refinement (default 3). */
  minTextGrowth?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

interface QueuedChunk {
  data: Float32Array;
  timestamp: number;
}

export class TeamsCaptionRouter {
  private readonly sink: MeetingAudioSink;
  private readonly botNameLower: string;
  private readonly maxQueueAgeMs: number;
  private readonly lookbackMs: number;
  private readonly minTextGrowth: number;
  private readonly now: () => number;

  private readonly queue: QueuedChunk[] = [];
  private readonly namedSpeakers = new Set<string>();
  private lastCaptionSpeaker: string | null = null;
  private lastFlushedTextLength = 0;
  private lastProcessedCaptionKey = "";
  private captionSeen = false;
  private voiceFallbackSpeaker: string | null = null;

  constructor(options: TeamsCaptionRouterOptions) {
    this.sink = options.sink;
    this.botNameLower = options.botName.toLowerCase();
    this.maxQueueAgeMs = options.maxQueueAgeMs ?? 10_000;
    this.lookbackMs = options.lookbackMs ?? 2_000;
    this.minTextGrowth = options.minTextGrowth ?? 3;
    this.now = options.now ?? Date.now;
  }

  /** True once at least one caption has been observed (captions own routing). */
  get captionsActive(): boolean {
    return this.captionSeen;
  }

  /** The speaker most recently attributed by captions (or voice fallback). */
  get currentSpeaker(): string | null {
    return this.captionSeen
      ? this.lastCaptionSpeaker
      : this.voiceFallbackSpeaker;
  }

  /** Enqueue an RMS-gated PCM chunk from the mixed Teams audio element. */
  onAudioChunk(samples: Float32Array, atMs = this.now()): void {
    this.queue.push({ data: samples, timestamp: atMs });
    this.evictStale(atMs);
  }

  /**
   * Caption observation: latest (author, text) pair from the caption DOM.
   * Drives speaker-change flushes and text-growth flushes.
   */
  onCaption(speaker: string, text: string): void {
    const trimmedSpeaker = speaker.trim();
    const trimmedText = text.trim();
    if (!trimmedSpeaker || !trimmedText) return;

    // Dedupe: Teams rewrites caption text in place as ASR refines.
    const captionKey = `${trimmedSpeaker}::${trimmedText}`;
    if (captionKey === this.lastProcessedCaptionKey) return;
    this.lastProcessedCaptionKey = captionKey;

    if (this.isBot(trimmedSpeaker)) return;
    this.captionSeen = true;

    const nowMs = this.now();

    if (trimmedSpeaker !== this.lastCaptionSpeaker) {
      // Speaker change: the queue holds the NEW speaker's opening words that
      // accumulated during the caption delay. Discard chunks older than the
      // lookback window, flush the rest to the new speaker.
      this.lastFlushedTextLength = 0;
      const cutoff = nowMs - this.lookbackMs;
      while (this.queue.length > 0 && this.queue[0].timestamp < cutoff) {
        this.queue.shift();
      }
      const previous = this.lastCaptionSpeaker;
      this.flushQueueTo(trimmedSpeaker);
      if (previous) this.sink.flushSpeaker(previous);
      this.lastCaptionSpeaker = trimmedSpeaker;
    }

    // Flush on text GROWTH (new words). Refinements (punctuation/case) move
    // length by 1–2 chars; new words grow it by 5+. A shrink means Teams
    // started a fresh caption entry — flush too.
    const growth = trimmedText.length - this.lastFlushedTextLength;
    if (
      growth > this.minTextGrowth ||
      trimmedText.length < this.lastFlushedTextLength
    ) {
      this.flushQueueTo(trimmedSpeaker);
      this.lastFlushedTextLength = trimmedText.length;
    }
  }

  /**
   * Voice-level-indicator fallback ([data-tid="voice-level-stream-outline"]).
   * Only routes while no caption has ever been observed; the first caption
   * permanently hands routing to the caption path.
   */
  onVoiceActivity(participantName: string, speaking: boolean): void {
    if (this.captionSeen) return;
    const name = participantName.trim();
    if (!name || this.isBot(name)) return;

    if (speaking) {
      if (this.voiceFallbackSpeaker !== name) {
        const previous = this.voiceFallbackSpeaker;
        // Same lookback rule: keep only the recent window for the new speaker.
        const cutoff = this.now() - this.lookbackMs;
        while (this.queue.length > 0 && this.queue[0].timestamp < cutoff) {
          this.queue.shift();
        }
        if (previous) this.sink.flushSpeaker(previous);
        this.voiceFallbackSpeaker = name;
      }
      this.flushQueueTo(name);
    } else if (this.voiceFallbackSpeaker === name) {
      this.flushQueueTo(name);
      this.sink.flushSpeaker(name);
      this.voiceFallbackSpeaker = null;
    }
  }

  /** Drain any remaining buffered audio to the current speaker. */
  finalize(): void {
    const speaker = this.currentSpeaker;
    if (speaker) {
      this.flushQueueTo(speaker);
      this.sink.flushSpeaker(speaker);
    } else {
      this.queue.length = 0;
    }
  }

  /** Number of chunks currently buffered (test observability). */
  get queuedChunks(): number {
    return this.queue.length;
  }

  private flushQueueTo(speaker: string): void {
    if (this.queue.length === 0) return;
    if (!this.namedSpeakers.has(speaker)) {
      this.namedSpeakers.add(speaker);
      this.sink.setSpeakerName(speaker, speaker);
    }
    while (this.queue.length > 0) {
      const entry = this.queue.shift() as QueuedChunk;
      this.sink.pushSpeakerAudio(speaker, entry.data);
    }
  }

  private evictStale(nowMs: number): void {
    while (
      this.queue.length > 0 &&
      nowMs - this.queue[0].timestamp > this.maxQueueAgeMs
    ) {
      this.queue.shift();
    }
  }

  private isBot(speaker: string): boolean {
    return speaker.toLowerCase().includes(this.botNameLower);
  }
}
