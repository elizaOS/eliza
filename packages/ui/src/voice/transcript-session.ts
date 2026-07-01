/**
 * Transcript session accumulator (#8789).
 *
 * While transcription mode is on, each finalized utterance is folded into a
 * single recording session instead of being posted as its own chat bubble. On
 * exit, the session's segments become one {@link Transcript} record (+ a chat
 * link-widget), and the per-utterance WAVs are concatenated into ONE
 * speech-only session WAV that the player scrubs.
 *
 * Timeline: when an utterance carries audio (the local-inference backend), the
 * segment span is the utterance's AUDIO duration, laid end-to-end — so the
 * concatenated speech-only audio matches the segment/word timeline exactly
 * (no dead air, `<audio>.currentTime` lines up with the highlight). Per-word
 * timings from the fused ASR (ABI v12) are offset into session time. When an
 * utterance has no audio (browser/talkmode), it falls back to a wall-clock
 * span and segment-level highlight. Pure (the caller injects "now").
 */

import type { TranscriptSegment } from "@elizaos/shared/transcripts";

export interface AddFinalOptions {
  speakerLabel?: string;
  /** Per-word timings relative to THIS utterance's start (ms). */
  words?: ReadonlyArray<{ text: string; startMs: number; endMs: number }>;
  /** The utterance's mono PCM16 WAV (RIFF header carries the sample rate). */
  audioWav?: Uint8Array;
}

/** Decode a standard 44-byte-header mono PCM16 WAV → samples + sample rate. */
function decodeMonoPcm16Wav(
  wav: Uint8Array,
): { pcm: Int16Array; sampleRate: number } | null {
  if (wav.byteLength <= 44) return null;
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  // "RIFF"…"WAVE" sanity check; sample rate at offset 24; data after 44.
  const sampleRate = view.getUint32(24, true);
  if (sampleRate <= 0) return null;
  const dataBytes = wav.byteLength - 44;
  const pcm = new Int16Array(dataBytes >> 1);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = view.getInt16(44 + i * 2, true);
  }
  return { pcm, sampleRate };
}

/** Encode concatenated mono PCM16 samples into one standard WAV. */
function encodeMonoPcm16Wav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++)
      view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono * 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  const out = new Uint8Array(buf);
  const pcmBytes = new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes);
  out.set(pcmBytes, 44);
  return out;
}

export class TranscriptSessionAccumulator {
  private readonly segments: TranscriptSegment[] = [];
  private readonly pcm: Int16Array[] = [];
  private sampleRate = 0;
  /** Audio-timeline cursor (ms) — where the next utterance's audio begins. */
  private cumulativeMs = 0;
  /** Wall-clock fallback cursor (ms) for audioless utterances. */
  private lastWallEndMs = 0;

  constructor(private readonly startedAtMs: number) {}

  /** Fold a finalized utterance into the session (empty text is ignored). */
  addFinal(text: string, nowMs: number, opts: AddFinalOptions = {}): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    const decoded = opts.audioWav ? decodeMonoPcm16Wav(opts.audioWav) : null;
    let startMs: number;
    let endMs: number;
    let words: TranscriptSegment["words"] = [];

    if (decoded) {
      if (this.sampleRate === 0) this.sampleRate = decoded.sampleRate;
      const durMs = Math.round(
        (decoded.pcm.length / decoded.sampleRate) * 1000,
      );
      startMs = this.cumulativeMs;
      endMs = startMs + Math.max(1, durMs);
      // Concatenate speech-only audio (only when the sample rate is uniform).
      if (decoded.sampleRate === this.sampleRate) this.pcm.push(decoded.pcm);
      // Offset the utterance's word timings into session time.
      words = (opts.words ?? []).map((w) => ({
        text: w.text,
        startMs: startMs + w.startMs,
        endMs: startMs + w.endMs,
      }));
      this.cumulativeMs = endMs;
      this.lastWallEndMs = endMs;
    } else {
      startMs = this.lastWallEndMs;
      endMs = Math.max(startMs + 1, Math.round(nowMs - this.startedAtMs));
      this.lastWallEndMs = endMs;
      this.cumulativeMs = endMs;
    }

    this.segments.push({
      id: `seg-${this.segments.length}`,
      speakerLabel: opts.speakerLabel,
      startMs,
      endMs,
      text: trimmed,
      words,
    });
  }

  /** Number of accumulated utterances. */
  get count(): number {
    return this.segments.length;
  }

  /** A copy of the accumulated segments (for the create request). */
  build(): TranscriptSegment[] {
    return this.segments.map((s) => ({ ...s, words: [...s.words] }));
  }

  /** The concatenated speech-only session WAV, or null when no audio retained. */
  buildAudioWav(): Uint8Array | null {
    if (this.pcm.length === 0 || this.sampleRate === 0) return null;
    const total = this.pcm.reduce((n, c) => n + c.length, 0);
    const all = new Int16Array(total);
    let offset = 0;
    for (const chunk of this.pcm) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    return encodeMonoPcm16Wav(all, this.sampleRate);
  }
}
