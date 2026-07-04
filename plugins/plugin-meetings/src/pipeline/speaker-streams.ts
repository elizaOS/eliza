/**
 * Per-speaker streaming ASR buffers with LocalAgreement-2 confirmation.
 *
 * Ported from Vexa (services/vexa-bot/core/src/services/speaker-streams.ts,
 * Apache-2.0 — see NOTICE) and restructured for the elizaOS runtime:
 * structured logger, injectable clock (session-absolute ms timing for
 * deterministic tests), typed segment/word shapes, and word-timing
 * passthrough onto confirmed segments.
 *
 * Two pointers track progress through each speaker's continuous stream:
 *   - confirmedSamples: audio before this was confirmed and emitted
 *   - totalSamples: end of the buffer
 *
 * Every submission sends only the unconfirmed window. On confirmation the
 * offset advances and confirmed audio is trimmed from the front. The buffer
 * never fully resets during continuous speech — only on speaker change,
 * idle timeout, or hard cap.
 */

import { logger } from "@elizaos/core";
import type { TranscriptWord } from "@elizaos/shared";
import { isHallucination } from "./hallucination-filter";

/** One ASR segment, times in seconds relative to the submitted audio window. */
export interface AsrSegment {
  text: string;
  startSec: number;
  endSec: number;
  /** Word timings relative to the submitted audio window, when available. */
  words?: ReadonlyArray<AsrSegmentWord>;
}

export interface AsrSegmentWord {
  text: string;
  startSec: number;
  endSec: number;
}

export type AsrSubmissionPurpose = "interim" | "final";

/** A confirmed utterance, times in ms on the manager's clock. */
export interface ConfirmedSegmentEvent {
  speakerKey: string;
  speakerName: string;
  text: string;
  startMs: number;
  endMs: number;
  /** Monotonic per-speaker sequence number. */
  seq: number;
  /** Absolute-ms word timings; empty when the backend supplied none. */
  words: TranscriptWord[];
}

export interface SpeakerStreamManagerConfig {
  /** Minimum unconfirmed audio before submission (seconds). Default: 2 */
  minAudioDurationSec?: number;
  /** Interval between submissions (seconds). Default: 2 */
  submitIntervalSec?: number;
  /** Consecutive identical full texts to confirm. Default: 2 */
  confirmThreshold?: number;
  /** Max total buffer before force-flush (seconds). Default: 30 */
  maxBufferDurationSec?: number;
  /** Idle timeout — final submit + reset after this many seconds. Default: 15 */
  idleTimeoutSec?: number;
  /** Sample rate of fed audio. Default: 16000 */
  sampleRate?: number;
  /** Clock in ms. Segment times are on this clock. Default: Date.now */
  now?: () => number;
}

interface SpeakerBuffer {
  speakerKey: string;
  speakerName: string;
  chunks: Float32Array[];
  totalSamples: number;
  /** Samples already confirmed and emitted — next submission starts here. */
  confirmedSamples: number;
  lastTranscript: string;
  confirmCount: number;
  /** Words from the previous submission (LocalAgreement-2 prefix source). */
  lastWords: string[];
  inFlight: boolean;
  /** Clock ms when the current unconfirmed window started. */
  windowStartMs: number;
  /** Monotonic sequence number for segment ids. */
  sequenceNumber: number;
  /** Clock ms when audio was last fed. */
  lastAudioTimestampMs: number;
  /** Whether a final idle/flush submission was already made. */
  idleSubmitted: boolean;
  /** Bumped on full reset — stale in-flight results are discarded. */
  generation: number;
  /** Last confirmed text — ASR prompt for context continuity + dedup. */
  lastConfirmedText: string;
}

export class SpeakerStreamManager {
  private readonly buffers = new Map<string, SpeakerBuffer>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly submitGeneration = new Map<string, number>();
  private readonly minAudioDurationSec: number;
  private readonly submitIntervalSec: number;
  private readonly confirmThreshold: number;
  private readonly maxBufferDurationSec: number;
  private readonly idleTimeoutSec: number;
  private readonly sampleRate: number;
  private readonly now: () => number;

  /** Called when unconfirmed audio needs transcription. */
  onSegmentReady:
    | ((
        speakerKey: string,
        speakerName: string,
        audio: Float32Array,
        purpose: AsrSubmissionPurpose,
      ) => void)
    | null = null;

  /** Called when a segment is confirmed and should be published. */
  onSegmentConfirmed: ((event: ConfirmedSegmentEvent) => void) | null = null;

  constructor(config?: SpeakerStreamManagerConfig) {
    this.minAudioDurationSec = config?.minAudioDurationSec ?? 2;
    this.submitIntervalSec = config?.submitIntervalSec ?? 2;
    this.confirmThreshold = config?.confirmThreshold ?? 2;
    this.maxBufferDurationSec = config?.maxBufferDurationSec ?? 30;
    this.idleTimeoutSec = config?.idleTimeoutSec ?? 15;
    this.sampleRate = config?.sampleRate ?? 16_000;
    this.now = config?.now ?? Date.now;
  }

  addSpeaker(speakerKey: string, speakerName: string): void {
    if (this.buffers.has(speakerKey)) return;

    const now = this.now();
    this.buffers.set(speakerKey, {
      speakerKey,
      speakerName,
      chunks: [],
      totalSamples: 0,
      confirmedSamples: 0,
      lastTranscript: "",
      confirmCount: 0,
      lastWords: [],
      inFlight: false,
      windowStartMs: now,
      sequenceNumber: 0,
      lastAudioTimestampMs: now,
      idleSubmitted: false,
      generation: 0,
      lastConfirmedText: "",
    });

    const timer = setInterval(
      () => this.trySubmit(speakerKey),
      this.submitIntervalSec * 1000,
    );
    this.timers.set(speakerKey, timer);

    logger.debug(
      `[MeetingPipeline] Added speaker stream "${speakerName}" (${speakerKey})`,
    );
  }

  feedAudio(speakerKey: string, audio: Float32Array): void {
    const buffer = this.buffers.get(speakerKey);
    if (!buffer) return;

    // Window start reflects when audio actually arrived after a reset, not
    // when the buffer was cleared — segment timing is anchored here.
    if (buffer.totalSamples === 0) {
      buffer.windowStartMs = this.now();
    }

    buffer.chunks.push(audio);
    buffer.totalSamples += audio.length;
    buffer.lastAudioTimestampMs = this.now();
    buffer.idleSubmitted = false;
  }

  /**
   * Handle an ASR result for a speaker's previously submitted window.
   *
   * With `segments` present, runs word-level prefix confirmation
   * (LocalAgreement-2): the longest common word prefix across two consecutive
   * submissions is stable; whole segments inside it are emitted with their
   * timings and the offset advances to the last confirmed segment boundary.
   * Otherwise falls back to full-text double-match confirmation.
   */
  handleTranscriptionResult(
    speakerKey: string,
    transcript: string,
    segmentEndSec?: number,
    segments?: ReadonlyArray<AsrSegment>,
  ): void {
    const buffer = this.buffers.get(speakerKey);
    if (!buffer) return;

    buffer.inFlight = false;

    // Discard stale responses: buffer was fully reset while this request was
    // in flight — accepting it would poison lastTranscript with old text.
    const submitGen = this.submitGeneration.get(speakerKey);
    if (submitGen !== undefined && submitGen < buffer.generation) return;

    if (!transcript || transcript.trim().length === 0) {
      if (buffer.idleSubmitted) this.fullReset(buffer);
      return;
    }

    const trimmed = transcript.trim();

    if (isHallucination(trimmed)) {
      logger.debug(
        `[MeetingPipeline] Filtered hallucination for "${buffer.speakerName}": "${trimmed.substring(0, 60)}"`,
      );
      if (buffer.idleSubmitted) this.fullReset(buffer);
      return;
    }

    // Idle/flush submit — last chance for this window, emit immediately.
    if (buffer.idleSubmitted) {
      this.emitSegment(buffer, trimmed, this.absoluteWords(buffer, segments));
      this.fullReset(buffer);
      return;
    }

    // LocalAgreement-2 word-prefix confirmation (UFAL whisper_streaming).
    if (segments && segments.length > 0) {
      const currentWords = segments.flatMap((s) =>
        s.text
          .trim()
          .split(/\s+/)
          .filter((w) => w.length > 0),
      );
      const prevWords = buffer.lastWords;

      let prefixLen = 0;
      const maxLen = Math.min(currentWords.length, prevWords.length);
      for (let i = 0; i < maxLen; i++) {
        if (currentWords[i] === prevWords[i]) prefixLen = i + 1;
        else break;
      }

      buffer.lastWords = currentWords;

      // Confirm when the prefix covers ≥1 word but NOT all current words —
      // the trailing words are still forming and may change next submission.
      if (prefixLen > 0 && prefixLen < currentWords.length) {
        // Map the confirmed prefix back onto whole segments; never emit a
        // partial segment.
        let wordsRemaining = prefixLen;
        let confirmedSegCount = 0;
        for (const seg of segments) {
          const segWordCount = seg.text
            .trim()
            .split(/\s+/)
            .filter((w) => w.length > 0).length;
          if (wordsRemaining >= segWordCount) {
            wordsRemaining -= segWordCount;
            confirmedSegCount++;
          } else {
            break;
          }
        }

        if (confirmedSegCount > 0) {
          const baseWindowMs = buffer.windowStartMs;
          for (let i = 0; i < confirmedSegCount; i++) {
            const seg = segments[i];
            const segText = seg.text.trim();
            buffer.windowStartMs =
              baseWindowMs + Math.floor(seg.startSec * 1000);
            const segEndMs = baseWindowMs + Math.floor(seg.endSec * 1000);
            if (!segText || !this.onSegmentConfirmed) continue;
            if (isHallucination(segText)) {
              logger.debug(
                `[MeetingPipeline] Filtered hallucination segment for "${buffer.speakerName}": "${segText.substring(0, 60)}"`,
              );
              continue;
            }
            this.onSegmentConfirmed({
              speakerKey: buffer.speakerKey,
              speakerName: buffer.speakerName,
              text: segText,
              startMs: buffer.windowStartMs,
              endMs: segEndMs,
              seq: buffer.sequenceNumber,
              words: this.segmentWords(baseWindowMs, seg),
            });
            buffer.sequenceNumber++;
            buffer.lastConfirmedText = segText;
          }
          const lastConfirmedSeg = segments[confirmedSegCount - 1];
          this.advanceOffset(buffer, lastConfirmedSeg.endSec);
          buffer.windowStartMs =
            baseWindowMs + Math.floor(lastConfirmedSeg.endSec * 1000);
          return;
        }
      }
      // No prefix confirmed — fall through to full-text check.
    }

    // Full-text double match — text identical across consecutive submissions.
    if (trimmed === buffer.lastTranscript) {
      buffer.confirmCount++;
    } else {
      buffer.lastTranscript = trimmed;
      buffer.confirmCount = 1;
    }

    if (buffer.confirmCount >= this.confirmThreshold) {
      this.emitSegment(buffer, trimmed, this.absoluteWords(buffer, segments));
      this.advanceOffset(buffer, segmentEndSec);
    }
  }

  hasSpeaker(speakerKey: string): boolean {
    return this.buffers.has(speakerKey);
  }

  updateSpeakerName(speakerKey: string, newName: string): boolean {
    const buffer = this.buffers.get(speakerKey);
    if (!buffer || buffer.speakerName === newName) return false;
    logger.debug(
      `[MeetingPipeline] Speaker "${buffer.speakerName}" → "${newName}" (${speakerKey})`,
    );
    buffer.speakerName = newName;
    return true;
  }

  getSpeakerName(speakerKey: string): string | undefined {
    return this.buffers.get(speakerKey)?.speakerName;
  }

  getActiveSpeakers(): string[] {
    return Array.from(this.buffers.keys());
  }

  getLastConfirmedText(speakerKey: string): string {
    return this.buffers.get(speakerKey)?.lastConfirmedText ?? "";
  }

  /** Snapshot of the still-unconfirmed tail for live "pending" rendering. */
  getPendingSnapshot(
    speakerKey: string,
  ): { text: string; startMs: number; speakerName: string } | null {
    const buffer = this.buffers.get(speakerKey);
    if (!buffer) return null;
    const text =
      buffer.lastWords.length > 0
        ? buffer.lastWords.join(" ")
        : buffer.lastTranscript;
    if (!text) return null;
    return {
      text,
      startMs: buffer.windowStartMs,
      speakerName: buffer.speakerName,
    };
  }

  removeSpeaker(speakerKey: string): void {
    const timer = this.timers.get(speakerKey);
    if (timer) clearInterval(timer);
    this.timers.delete(speakerKey);

    const buffer = this.buffers.get(speakerKey);
    if (
      buffer &&
      this.unconfirmedSamples(buffer) > 0 &&
      buffer.lastTranscript
    ) {
      this.emitSegment(buffer, buffer.lastTranscript, []);
    }

    this.buffers.delete(speakerKey);
    this.submitGeneration.delete(speakerKey);
  }

  removeAll(): void {
    for (const speakerKey of Array.from(this.buffers.keys())) {
      this.removeSpeaker(speakerKey);
    }
  }

  /**
   * Force-flush on speaker change / mute / leave. If a transcript is already
   * forming, emit it and reset. If there is audio but no transcript yet,
   * make one final submission (marked idle so its result emits immediately).
   */
  async flushSpeaker(speakerKey: string): Promise<void> {
    const buffer = this.buffers.get(speakerKey);
    if (!buffer) return;

    if (buffer.lastTranscript) {
      this.emitSegment(buffer, buffer.lastTranscript, []);
      this.fullReset(buffer);
      return;
    }

    if (this.unconfirmedSamples(buffer) > 0 && !buffer.inFlight) {
      buffer.idleSubmitted = true;
      logger.debug(
        `[MeetingPipeline] Flush-submit for "${buffer.speakerName}" (${(
          this.unconfirmedSamples(buffer) / this.sampleRate
        ).toFixed(1)}s audio, no transcript yet)`,
      );
      this.submitBuffer(buffer, "final");
      return;
    }

    this.fullReset(buffer);
  }

  // ── Private ──────────────────────────────────────────────────

  private segmentWords(
    baseWindowMs: number,
    seg: AsrSegment,
  ): TranscriptWord[] {
    if (!seg.words || seg.words.length === 0) return [];
    return seg.words.map((w) => ({
      text: w.text,
      startMs: baseWindowMs + Math.floor(w.startSec * 1000),
      endMs: baseWindowMs + Math.floor(w.endSec * 1000),
    }));
  }

  /** All word timings across segments, absolute on this buffer's window. */
  private absoluteWords(
    buffer: SpeakerBuffer,
    segments?: ReadonlyArray<AsrSegment>,
  ): TranscriptWord[] {
    if (!segments) return [];
    const base = buffer.windowStartMs;
    return segments.flatMap((seg) => this.segmentWords(base, seg));
  }

  private unconfirmedSamples(buffer: SpeakerBuffer): number {
    return buffer.totalSamples - buffer.confirmedSamples;
  }

  private trySubmit(speakerKey: string): void {
    const buffer = this.buffers.get(speakerKey);
    if (!buffer || buffer.inFlight) return;

    const unconfirmedSec = this.unconfirmedSamples(buffer) / this.sampleRate;
    const totalSec = buffer.totalSamples / this.sampleRate;
    const idleMs = this.now() - buffer.lastAudioTimestampMs;

    // Idle timeout: one final submission, then cleanup on the next tick.
    if (
      idleMs > this.idleTimeoutSec * 1000 &&
      this.unconfirmedSamples(buffer) > 0
    ) {
      if (!buffer.idleSubmitted) {
        buffer.idleSubmitted = true;
        logger.debug(
          `[MeetingPipeline] Idle submit for "${buffer.speakerName}" (${(idleMs / 1000).toFixed(1)}s idle)`,
        );
        this.submitBuffer(buffer, "final");
        return;
      }
      if (!buffer.inFlight) {
        if (buffer.lastTranscript) {
          this.emitSegment(buffer, buffer.lastTranscript, []);
        }
        logger.debug(
          `[MeetingPipeline] Idle cleanup for "${buffer.speakerName}" (${(idleMs / 1000).toFixed(1)}s idle)`,
        );
        this.fullReset(buffer);
      }
      return;
    }

    // Hard cap — force-flush (nothing ever confirmed) or trim.
    if (totalSec > this.maxBufferDurationSec) {
      if (buffer.confirmedSamples === 0) {
        if (buffer.lastTranscript) {
          logger.debug(
            `[MeetingPipeline] Hard-cap force-flush for "${buffer.speakerName}" (${totalSec.toFixed(1)}s > ${this.maxBufferDurationSec}s)`,
          );
          this.emitSegment(buffer, buffer.lastTranscript, []);
        }
        this.fullReset(buffer);
        return;
      }
      this.trimBuffer(buffer);
    }

    if (unconfirmedSec >= this.minAudioDurationSec) {
      this.submitBuffer(buffer, "interim");
    }
  }

  /** Submit only the unconfirmed window to the ASR callback. */
  private submitBuffer(
    buffer: SpeakerBuffer,
    purpose: AsrSubmissionPurpose,
  ): void {
    const unconfirmed = this.unconfirmedSamples(buffer);
    if (unconfirmed === 0 || !this.onSegmentReady) return;

    const combined = new Float32Array(unconfirmed);
    let dstOffset = 0;
    let samplesToSkip = buffer.confirmedSamples;

    for (const chunk of buffer.chunks) {
      if (samplesToSkip >= chunk.length) {
        samplesToSkip -= chunk.length;
        continue;
      }
      const start = samplesToSkip;
      samplesToSkip = 0;
      combined.set(chunk.subarray(start), dstOffset);
      dstOffset += chunk.length - start;
    }

    buffer.inFlight = true;
    this.submitGeneration.set(buffer.speakerKey, buffer.generation);

    try {
      this.onSegmentReady(
        buffer.speakerKey,
        buffer.speakerName,
        combined,
        purpose,
      );
    } catch (err) {
      buffer.inFlight = false;
      logger.error({ err }, "[MeetingPipeline] onSegmentReady threw");
    }
  }

  /** Emit a confirmed segment. Does NOT reset the buffer. */
  private emitSegment(
    buffer: SpeakerBuffer,
    text: string,
    words: TranscriptWord[],
  ): void {
    if (!text || !this.onSegmentConfirmed) return;
    if (isHallucination(text)) {
      logger.debug(
        `[MeetingPipeline] Filtered hallucination in emit for "${buffer.speakerName}": "${text.substring(0, 60)}"`,
      );
      return;
    }
    // Dedup: acoustic echo / residual audio re-confirming the same text.
    if (text === buffer.lastConfirmedText) {
      logger.debug(
        `[MeetingPipeline] Dedup skip for "${buffer.speakerName}": "${text.substring(0, 50)}"`,
      );
      return;
    }
    this.onSegmentConfirmed({
      speakerKey: buffer.speakerKey,
      speakerName: buffer.speakerName,
      text,
      startMs: buffer.windowStartMs,
      endMs: this.now(),
      seq: buffer.sequenceNumber,
      words,
    });
    buffer.sequenceNumber++;
    buffer.lastConfirmedText = text;
  }

  /**
   * Advance the offset to the ASR segment boundary and trim confirmed audio.
   * Audio after the boundary stays for the next submission; without a
   * boundary, trims the full unconfirmed window.
   */
  private advanceOffset(buffer: SpeakerBuffer, segmentEndSec?: number): void {
    if (segmentEndSec !== undefined) {
      const samplesToAdvance = Math.floor(segmentEndSec * this.sampleRate);
      buffer.confirmedSamples += Math.min(
        samplesToAdvance,
        this.unconfirmedSamples(buffer),
      );
    } else {
      buffer.confirmedSamples = buffer.totalSamples;
    }

    this.trimBuffer(buffer);

    buffer.lastTranscript = "";
    buffer.confirmCount = 0;
    buffer.lastWords = [];
    buffer.windowStartMs = this.now();
  }

  /** Trim confirmed audio chunks from the front; unconfirmed audio stays. */
  private trimBuffer(buffer: SpeakerBuffer): void {
    if (buffer.confirmedSamples === 0) return;

    let samplesToTrim = buffer.confirmedSamples;
    const newChunks: Float32Array[] = [];

    for (const chunk of buffer.chunks) {
      if (samplesToTrim >= chunk.length) {
        samplesToTrim -= chunk.length;
        continue;
      }
      if (samplesToTrim > 0) {
        newChunks.push(chunk.subarray(samplesToTrim));
        samplesToTrim = 0;
      } else {
        newChunks.push(chunk);
      }
    }

    buffer.chunks = newChunks;
    buffer.totalSamples -= buffer.confirmedSamples;
    buffer.confirmedSamples = 0;
  }

  /** Discard everything — speaker change and idle cleanup. */
  private fullReset(buffer: SpeakerBuffer): void {
    buffer.chunks = [];
    buffer.totalSamples = 0;
    buffer.confirmedSamples = 0;
    buffer.lastTranscript = "";
    buffer.confirmCount = 0;
    buffer.lastWords = [];
    buffer.inFlight = false;
    buffer.windowStartMs = this.now();
    buffer.lastAudioTimestampMs = this.now();
    buffer.idleSubmitted = false;
    buffer.generation++;
  }
}
