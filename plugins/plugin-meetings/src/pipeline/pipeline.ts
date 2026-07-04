/**
 * MeetingTranscriptionPipeline — the MeetingAudioSink implementation.
 *
 * Platform adapters push per-speaker 16 kHz mono Float32 PCM; this pipeline
 * buffers it per speaker (SpeakerStreamManager), transcribes unconfirmed
 * windows through an {@link AsrBackend}, confirms text with LocalAgreement-2
 * / full-text double-match, filters hallucinations, and assembles
 * `TranscriptSegment`s with session-relative ms timing (0 = pipeline
 * creation).
 *
 * When `retainAudio` is set, every pushed chunk is also accumulated into a
 * session mix (all speakers summed at their session-time offsets, clipped to
 * [-1, 1]) exposed as `sessionAudioWav()` — the service layer stores it as
 * the transcript record's audio.
 */

import type { Buffer } from "node:buffer";
import { logger } from "@elizaos/core";
import type { MeetingParticipant, TranscriptSegment } from "@elizaos/shared";
import {
  MEETING_AUDIO_SAMPLE_RATE,
  type MeetingPipelineOptions,
  type MeetingTranscriptionPipeline,
  type PipelineTranscriptUpdate,
} from "../types";
import { type AsrSegment, SpeakerStreamManager } from "./speaker-streams";
import { type AsrBackend, RuntimeModelAsrBackend } from "./transcriber";
import { float32ToWav } from "./wav";

/** Silence gap (ms) between words that splits a submission into segments. */
const WORD_GAP_SEGMENT_SPLIT_MS = 600;

interface RetainedChunk {
  offsetSamples: number;
  samples: Float32Array;
}

/** Group backend word timings into gap-split ASR segments (sec, window-relative). */
function wordsToAsrSegments(
  words: ReadonlyArray<{ text: string; startMs: number; endMs: number }>,
): AsrSegment[] {
  const segments: AsrSegment[] = [];
  let group: Array<{ text: string; startMs: number; endMs: number }> = [];

  const flush = (): void => {
    if (group.length === 0) return;
    segments.push({
      text: group
        .map((w) => w.text)
        .join(" ")
        .trim(),
      startSec: group[0].startMs / 1000,
      endSec: group[group.length - 1].endMs / 1000,
      words: group.map((w) => ({
        text: w.text,
        startSec: w.startMs / 1000,
        endSec: w.endMs / 1000,
      })),
    });
    group = [];
  };

  for (const word of words) {
    const prev = group[group.length - 1];
    if (prev && word.startMs - prev.endMs > WORD_GAP_SEGMENT_SPLIT_MS) flush();
    group.push(word);
  }
  flush();
  return segments.filter((s) => s.text.length > 0);
}

class MeetingPipeline implements MeetingTranscriptionPipeline {
  private readonly manager: SpeakerStreamManager;
  private readonly backend: AsrBackend;
  private readonly sessionEpochMs = Date.now();
  private readonly idPrefix: string;

  private readonly confirmed: TranscriptSegment[] = [];
  private readonly listeners = new Set<
    (update: PipelineTranscriptUpdate) => void
  >();
  private readonly outstanding = new Set<Promise<void>>();

  /** speakerKey → display name (setSpeakerName vote-and-lock result). */
  private readonly names = new Map<string, string>();
  /** speakerKey → fallback label ("Speaker N") in first-audio order. */
  private readonly fallbackLabels = new Map<string, string>();
  private readonly participants = new Map<string, MeetingParticipant>();
  private readonly retained: RetainedChunk[] = [];
  private retainedTotalSamples = 0;
  private finalized = false;

  constructor(
    private readonly options: MeetingPipelineOptions,
    backend?: AsrBackend,
  ) {
    this.backend = backend ?? new RuntimeModelAsrBackend(options.runtime);
    this.idPrefix = options.sessionId.slice(0, 8);
    this.manager = new SpeakerStreamManager({
      sampleRate: MEETING_AUDIO_SAMPLE_RATE,
      now: () => Date.now() - this.sessionEpochMs,
    });

    this.manager.onSegmentReady = (
      speakerKey,
      _speakerName,
      audio,
      purpose,
    ) => {
      this.transcribeWindow(speakerKey, audio, purpose);
    };

    this.manager.onSegmentConfirmed = (event) => {
      const segment: TranscriptSegment = {
        id: `${this.idPrefix}:${event.speakerKey}:${event.seq}`,
        speakerLabel: event.speakerName,
        startMs: Math.max(0, event.startMs),
        endMs: Math.max(0, event.endMs),
        text: event.text,
        words: event.words,
      };
      this.confirmed.push(segment);
      this.notify([segment]);
    };
  }

  // ── MeetingAudioSink ─────────────────────────────────────────

  pushSpeakerAudio(speakerKey: string, samples: Float32Array): void {
    if (this.finalized || samples.length === 0) return;

    // Copy once: adapters may reuse their capture buffers, and the copy is
    // shared between the stream manager and the retained session mix.
    const chunk = samples.slice();

    if (!this.manager.hasSpeaker(speakerKey)) {
      this.manager.addSpeaker(speakerKey, this.labelFor(speakerKey));
    }
    this.manager.feedAudio(speakerKey, chunk);

    if (this.options.retainAudio) {
      const offsetSamples = Math.round(
        ((Date.now() - this.sessionEpochMs) / 1000) * MEETING_AUDIO_SAMPLE_RATE,
      );
      this.retained.push({ offsetSamples, samples: chunk });
      this.retainedTotalSamples = Math.max(
        this.retainedTotalSamples,
        offsetSamples + chunk.length,
      );
    }
  }

  setSpeakerName(speakerKey: string, displayName: string): void {
    const name = displayName.trim();
    if (!name) return;
    this.names.set(speakerKey, name);
    this.manager.updateSpeakerName(speakerKey, name);
  }

  flushSpeaker(speakerKey: string): void {
    void this.manager.flushSpeaker(speakerKey);
  }

  participantJoined(participant: MeetingParticipant): void {
    this.participants.set(participant.id, participant);
  }

  participantLeft(participantId: string, atMs: number): void {
    const participant = this.participants.get(participantId);
    if (participant) {
      this.participants.set(participantId, { ...participant, leftAtMs: atMs });
    }
  }

  // ── MeetingTranscriptionPipeline ─────────────────────────────

  onUpdate(listener: (update: PipelineTranscriptUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async finalize(): Promise<TranscriptSegment[]> {
    if (!this.finalized) {
      this.finalized = true;

      // Final flush: speakers with a forming transcript emit it; speakers
      // with audio but no transcript yet get one last ASR submission.
      for (const speakerKey of this.manager.getActiveSpeakers()) {
        await this.manager.flushSpeaker(speakerKey);
      }

      // Drain every in-flight ASR call (flushes above may have queued more).
      while (this.outstanding.size > 0) {
        await Promise.allSettled(Array.from(this.outstanding));
      }

      this.manager.removeAll();
      this.confirmed.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
      this.notify([]);
      logger.info(
        `[MeetingPipeline] Finalized session ${this.idPrefix}: ${this.confirmed.length} segments, ${this.speakerNames().length} speakers`,
      );
    }
    return [...this.confirmed];
  }

  speakerNames(): string[] {
    const names = new Set<string>();
    for (const segment of this.confirmed) {
      if (segment.speakerLabel) names.add(segment.speakerLabel);
    }
    for (const key of this.fallbackLabels.keys()) {
      names.add(this.labelFor(key));
    }
    for (const name of this.names.values()) names.add(name);
    return Array.from(names);
  }

  /**
   * Mixed session audio (all speakers summed at session-time offsets,
   * clipped to [-1,1]) as a 16 kHz mono 16-bit PCM WAV. Null unless
   * `retainAudio` was set or nothing was captured. The service layer stores
   * this next to the transcript record for the audio player.
   */
  sessionAudioWav(): Buffer | null {
    if (!this.options.retainAudio || this.retainedTotalSamples === 0) {
      return null;
    }
    const mix = new Float32Array(this.retainedTotalSamples);
    for (const { offsetSamples, samples } of this.retained) {
      for (let i = 0; i < samples.length; i++) {
        const at = offsetSamples + i;
        const sum = mix[at] + samples[i];
        mix[at] = Math.max(-1, Math.min(1, sum)); // clipping guard
      }
    }
    const wav = float32ToWav(mix, MEETING_AUDIO_SAMPLE_RATE);
    // One-shot terminal read: the service consumes this once at finalize, so
    // release every retained Float32 chunk now. Left in place they pin the full
    // session's PCM (minutes of 16 kHz mono) for the pipeline's whole lifetime —
    // an unbounded per-meeting leak. Reset the sample count too so the state is
    // coherent (a repeat call returns null rather than a buffer of silence).
    this.retained.length = 0;
    this.retainedTotalSamples = 0;
    return wav;
  }

  // ── Private ──────────────────────────────────────────────────

  private labelFor(speakerKey: string): string {
    const named = this.names.get(speakerKey);
    if (named) return named;
    let fallback = this.fallbackLabels.get(speakerKey);
    if (!fallback) {
      fallback = `Speaker ${this.fallbackLabels.size + 1}`;
      this.fallbackLabels.set(speakerKey, fallback);
    }
    return fallback;
  }

  private transcribeWindow(
    speakerKey: string,
    audio: Float32Array,
    purpose: "interim" | "final",
  ): void {
    const wav = float32ToWav(audio, MEETING_AUDIO_SAMPLE_RATE);
    const prompt = this.manager.getLastConfirmedText(speakerKey);
    const durationSec = audio.length / MEETING_AUDIO_SAMPLE_RATE;

    const task = (async () => {
      try {
        const result = await this.backend.transcribe(wav, {
          ...(this.options.language ? { language: this.options.language } : {}),
          ...(prompt ? { prompt } : {}),
          purpose,
        });
        const segments =
          result.words && result.words.length > 0
            ? wordsToAsrSegments(result.words)
            : undefined;
        const segmentEndSec = segments
          ? segments[segments.length - 1]?.endSec
          : result.text
            ? durationSec
            : undefined;
        this.manager.handleTranscriptionResult(
          speakerKey,
          result.text,
          segmentEndSec,
          segments,
        );
      } catch (err) {
        // error-policy:J7 a single ASR window failing (already retried in the
        // backend) must not stall live transcription — drop the window and let
        // the stream keep moving. But surface the failure via reportError so a
        // *systemically* broken TRANSCRIPTION model becomes observable to the
        // agent/owner (RECENT_ERRORS + escalation) instead of silently yielding
        // an empty transcript.
        logger.error(
          { err },
          `[MeetingPipeline] ASR failed for speaker ${speakerKey}; window dropped`,
        );
        this.options.runtime.reportError?.("MeetingPipeline.transcribe", err, {
          sessionId: this.options.sessionId,
          speakerKey,
        });
        // Clear the in-flight flag so the stream keeps moving.
        this.manager.handleTranscriptionResult(speakerKey, "");
      }
      this.notify([]);
    })();

    this.outstanding.add(task);
    void task.finally(() => this.outstanding.delete(task));
  }

  private pendingSegments(): TranscriptSegment[] {
    const pending: TranscriptSegment[] = [];
    for (const speakerKey of this.manager.getActiveSpeakers()) {
      const snapshot = this.manager.getPendingSnapshot(speakerKey);
      if (!snapshot) continue;
      pending.push({
        id: `${this.idPrefix}:${speakerKey}:pending`,
        speakerLabel: snapshot.speakerName,
        startMs: Math.max(0, snapshot.startMs),
        endMs: Date.now() - this.sessionEpochMs,
        text: snapshot.text,
        words: [],
      });
    }
    return pending;
  }

  private notify(newlyConfirmed: TranscriptSegment[]): void {
    if (this.listeners.size === 0) return;
    const update: PipelineTranscriptUpdate = {
      confirmed: newlyConfirmed,
      pending: this.finalized ? [] : this.pendingSegments(),
    };
    for (const listener of this.listeners) {
      try {
        listener(update);
      } catch (err) {
        logger.error({ err }, "[MeetingPipeline] onUpdate listener threw");
      }
    }
  }
}

/**
 * Create the transcription pipeline for one meeting session. `backend` is
 * injectable for tests and alternate ASR providers; the default routes
 * through `runtime.useModel(ModelType.TRANSCRIPTION)`.
 */
export function createMeetingTranscriptionPipeline(
  options: MeetingPipelineOptions,
  backend?: AsrBackend,
): MeetingTranscriptionPipeline & { sessionAudioWav(): Buffer | null } {
  return new MeetingPipeline(options, backend);
}
