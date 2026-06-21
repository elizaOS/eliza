/**
 * Transcript session accumulator (#8789).
 *
 * While transcription mode is on, each finalized utterance is folded into a
 * single recording session instead of being posted as its own chat bubble. On
 * exit, the session's segments become one {@link Transcript} record (+ a chat
 * link-widget). Timing is relative to the session start (ms), the unit the
 * player highlights against; each utterance spans from the previous one's end
 * to its own finalize time, so the segments are contiguous and scrubbable.
 *
 * Pure (the caller injects "now") so it is deterministic + unit-testable. Word
 * timings are left empty here — they are filled by the forced-aligner when the
 * CTC acoustic model is available; otherwise the player highlights per segment.
 */

import type { TranscriptSegment } from "@elizaos/shared/transcripts";

export class TranscriptSessionAccumulator {
  private readonly segments: TranscriptSegment[] = [];
  private lastEndMs = 0;

  constructor(private readonly startedAtMs: number) {}

  /** Fold a finalized utterance into the session (empty text is ignored). */
  addFinal(text: string, nowMs: number, speakerLabel?: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const startMs = this.lastEndMs;
    const endMs = Math.max(startMs + 1, Math.round(nowMs - this.startedAtMs));
    this.segments.push({
      id: `seg-${this.segments.length}`,
      speakerLabel,
      startMs,
      endMs,
      text: trimmed,
      words: [],
    });
    this.lastEndMs = endMs;
  }

  /** Number of accumulated utterances. */
  get count(): number {
    return this.segments.length;
  }

  /** A copy of the accumulated segments (for the create request). */
  build(): TranscriptSegment[] {
    return this.segments.map((s) => ({ ...s }));
  }
}
