/**
 * Ambient-transcription segment events for the pendant transcript surface.
 *
 * The voice path still emits finalized text on `PENDANT_VOICE_TRANSCRIPT_EVENT`
 * so chat can send a spoken VOICE_DM. This channel is a passive transcript feed:
 * it announces each VAD utterance as pending, then resolves it with text and
 * word timings or drops it when no usable ASR result exists.
 */

/** Custom window event carrying an ambient-transcript segment lifecycle update. */
export const PENDANT_TRANSCRIPT_SEGMENT_EVENT =
  "eliza:pendant:transcript-segment" as const;

/** Lifecycle state of one ambient utterance segment. */
export type PendantSegmentStatus = "pending" | "resolved" | "dropped";

export interface PendantAsrWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface PendantTranscriptSegmentDetail {
  /** Stable id for this segment across its pending → resolved/dropped updates. */
  id: string;
  status: PendantSegmentStatus;
  /** Resolved transcript text (present once `status === "resolved"`). */
  text?: string;
  /** Epoch ms the utterance started, reconstructed from submitted audio length. */
  startedAt: number;
  /** Epoch ms the utterance ended and ASR was dispatched. */
  endedAt: number;
  /** Submitted utterance duration in milliseconds. */
  durationMs: number;
  /** Local ASR word timings normalized relative to this segment start. */
  words?: PendantAsrWord[];
}

export function normalizePendantAsrWords(
  words: ReadonlyArray<PendantAsrWord>,
  durationMs: number,
): PendantAsrWord[] {
  const safeDuration = Math.max(0, Math.round(durationMs));
  let previousEndMs = 0;
  const normalized: PendantAsrWord[] = [];
  for (const word of words) {
    const text = word.text.trim();
    if (!text) continue;
    const rawStart = Number.isFinite(word.startMs) ? word.startMs : 0;
    const rawEnd = Number.isFinite(word.endMs) ? word.endMs : rawStart;
    const boundedStart = Math.min(
      safeDuration,
      Math.max(0, Math.round(rawStart)),
    );
    const boundedEnd = Math.min(
      safeDuration,
      Math.max(boundedStart, Math.round(rawEnd)),
    );
    const startMs = Math.max(previousEndMs, boundedStart);
    const endMs = Math.max(startMs, boundedEnd);
    normalized.push({ text, startMs, endMs });
    previousEndMs = endMs;
  }
  return normalized;
}

/** Dispatch an ambient-transcript segment lifecycle update. */
export function dispatchPendantTranscriptSegment(
  detail: PendantTranscriptSegmentDetail,
): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<PendantTranscriptSegmentDetail>(
      PENDANT_TRANSCRIPT_SEGMENT_EVENT,
      { detail },
    ),
  );
}
