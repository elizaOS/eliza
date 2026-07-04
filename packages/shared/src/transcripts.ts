/**
 * Transcripts — the canonical contract for a recorded + transcribed session.
 *
 * One shape, shared across every layer: the ASR/diarization pipeline that
 * PRODUCES a transcript (plugin-local-inference), the service that STORES it and
 * mirrors its text into the knowledge/documents store, the API route + client
 * that TRANSPORT it, and the Transcripts view that PLAYS it back with
 * word-synced highlighting. Keeping the shape here (pure, browser- + node-safe)
 * means the word-timing model is defined exactly once.
 *
 * Timing convention: every `startMs`/`endMs` is milliseconds from the START of
 * the recording's audio (0 = first sample), so the same numbers drive both the
 * stored record and the `<audio>.currentTime`-based player highlight.
 */

/** A single transcribed word with playback-synced timing (ms from audio start). */
export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  /** ASR confidence 0..1, when the backend reports it. */
  confidence?: number;
}

/**
 * One diarized, word-timed span — a single speaker's contiguous utterance.
 * `words` is empty only when the ASR backend supplied no per-word timing (the
 * player then falls back to segment-level highlighting).
 */
export interface TranscriptSegment {
  id: string;
  /** Stable speaker label within this transcript (e.g. "Speaker 1" or a name). */
  speakerLabel?: string;
  /** Resolved elizaOS entity id when the voice was recognized (evidence-linked). */
  speakerEntityId?: string;
  startMs: number;
  endMs: number;
  /** Segment text (the join of `words`, or raw ASR text when words are absent). */
  text: string;
  words: TranscriptWord[];
  confidence?: number;
}

export type TranscriptSource =
  | "voice-session"
  | "import"
  | "call"
  | "meeting"
  | "unknown";

/** Visibility scope — mirrors the documents store's `DocumentVisibilityScope`. */
export type TranscriptScope =
  | "owner-private"
  | "user-private"
  | "global"
  | "agent-private";

export type TranscriptStatus = "recording" | "processing" | "ready" | "failed";

/** A recorded + transcribed session: audio + word-timed diarized segments. */
export interface Transcript {
  id: string;
  title: string;
  /** Epoch ms when recording started. */
  createdAt: number;
  /** Epoch ms when the session ended; absent while still recording. */
  endedAt?: number;
  /** Epoch ms of the most recent user edit to the transcript text. */
  editedAt?: number;
  durationMs: number;
  /** Served audio URL (content-addressed media store); absent if not retained. */
  audioUrl?: string;
  audioContentType?: string;
  segments: TranscriptSegment[];
  source: TranscriptSource;
  scope: TranscriptScope;
  status: TranscriptStatus;
  /** The mirrored documents/knowledge item id (the searchable text copy). */
  knowledgeDocumentId?: string;
  /** Distinct speaker count across segments. */
  speakerCount: number;
  metadata?: Record<string, unknown>;
}

/**
 * Meeting-specific list-row fields, computed server-side from a meeting
 * transcript's metadata (never derived on the client). Present only on
 * `source: "meeting"` summaries.
 */
export interface TranscriptSummaryMeetingMeta {
  /** Meeting platform (a {@link MeetingPlatform} value) for the row badge. */
  platform?: string;
  /** Roster size at finalize — the "N participants" the list row shows. */
  participantCount: number;
}

/** Compact list-row projection for the transcripts index. */
export interface TranscriptSummary {
  id: string;
  title: string;
  createdAt: number;
  durationMs: number;
  speakerCount: number;
  status: TranscriptStatus;
  /** How the transcript was captured — drives meeting-aware row rendering. */
  source: TranscriptSource;
  /** First slice of the transcript text, for the list row. */
  preview: string;
  hasAudio: boolean;
  /** Server-computed meeting fields; present only for `source: "meeting"`. */
  meeting?: TranscriptSummaryMeetingMeta;
}

/** Default characters of transcript text kept for a list-row preview. */
export const TRANSCRIPT_PREVIEW_CHARS = 160;

/** Distinct speaker labels across the segments (unlabeled segments ignored). */
export function transcriptSpeakerCount(
  segments: ReadonlyArray<TranscriptSegment>,
): number {
  const labels = new Set<string>();
  for (const s of segments) if (s.speakerLabel) labels.add(s.speakerLabel);
  return labels.size;
}

/** Recording length in ms — the largest segment end (0 when empty). */
export function transcriptDurationMs(
  segments: ReadonlyArray<TranscriptSegment>,
): number {
  let max = 0;
  for (const s of segments) if (s.endMs > max) max = s.endMs;
  return max;
}

/**
 * Render the transcript as plain, speaker-labeled lines — the exact text that is
 * mirrored into the knowledge/documents store (so search + the provider read
 * the same words a human sees) and used for previews. One line per segment:
 * `Speaker: text` (label omitted when unknown).
 */
export function transcriptPlainText(
  segments: ReadonlyArray<TranscriptSegment>,
): string {
  return segments
    .map((s) => {
      const text = s.text.trim();
      if (!text) return "";
      return s.speakerLabel ? `${s.speakerLabel}: ${text}` : text;
    })
    .filter((line) => line.length > 0)
    .join("\n");
}

/** A one-line preview of the transcript text, capped to `max` chars. */
export function transcriptPreview(
  segments: ReadonlyArray<TranscriptSegment>,
  max = TRANSCRIPT_PREVIEW_CHARS,
): string {
  const flat = segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Read the meeting list-row fields off a meeting transcript's metadata. The
 * meetings writer stores `{ platform, participants }` (see
 * plugin-meetings' meeting-transcript-writer); the participant COUNT is
 * computed here, server-side, so the list row never counts a roster array in
 * the client.
 */
function summarizeMeetingMeta(
  metadata: Record<string, unknown> | undefined,
): TranscriptSummaryMeetingMeta {
  const platform =
    typeof metadata?.platform === "string" ? metadata.platform : undefined;
  const participants = metadata?.participants;
  const participantCount = Array.isArray(participants)
    ? participants.length
    : 0;
  return platform === undefined
    ? { participantCount }
    : { platform, participantCount };
}

/** Project a full transcript to its list-row summary. */
export function summarizeTranscript(transcript: Transcript): TranscriptSummary {
  return {
    id: transcript.id,
    title: transcript.title,
    createdAt: transcript.createdAt,
    durationMs: transcript.durationMs,
    speakerCount: transcript.speakerCount,
    status: transcript.status,
    source: transcript.source,
    preview: transcriptPreview(transcript.segments),
    hasAudio: Boolean(transcript.audioUrl),
    ...(transcript.source === "meeting"
      ? { meeting: summarizeMeetingMeta(transcript.metadata) }
      : {}),
  };
}

/** A word flattened across segments, carrying its origin indices for the UI. */
export interface FlatTranscriptWord extends TranscriptWord {
  segmentIndex: number;
  wordIndex: number;
}

/** Flatten all segments' words into one time-ordered array (for player sync). */
export function flattenTranscriptWords(
  segments: ReadonlyArray<TranscriptSegment>,
): FlatTranscriptWord[] {
  const out: FlatTranscriptWord[] = [];
  segments.forEach((segment, segmentIndex) => {
    segment.words.forEach((word, wordIndex) => {
      out.push({ ...word, segmentIndex, wordIndex });
    });
  });
  return out;
}

/**
 * Index of the word active at playback time `ms` within a flattened, ascending
 * word list, via binary search (cheap enough to call every `timeupdate`/frame).
 * Returns the last word whose `startMs <= ms`; -1 before the first word starts.
 * A word stays "active" until the next word begins, so gaps between words keep
 * the previous word lit rather than flickering off.
 */
export function activeWordIndex(
  words: ReadonlyArray<FlatTranscriptWord>,
  ms: number,
): number {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** A single invariant violation found by {@link validateAsrWordTimings}. */
export interface WordTimingViolation {
  index: number;
  word: string;
  reason: string;
}

/** Result of validating a word-timed sequence against the player contract. */
export interface WordTimingValidation {
  ok: boolean;
  violations: WordTimingViolation[];
}

/**
 * Validate per-word timings against the contract the transcript player relies
 * on — and that the fused ASR v12 (`eliza_inference_asr_transcribe_timed`) MUST
 * satisfy for its output to be playable:
 *
 *   - every word has non-empty text and finite `0 <= startMs <= endMs`,
 *   - spans are ordered and non-overlapping (each word starts no earlier than
 *     the previous word ends, within `toleranceMs`),
 *   - every span lies within `[0, audioDurationMs]` (the exact decoded audio
 *     length, `1000 * n_samples / sample_rate`).
 *
 * Pass `audioDurationMs = 0` to skip the upper-bound check. `toleranceMs`
 * absorbs the integer rounding the native char-proportional timing applies at
 * word boundaries. The same function gates the player highlight, the ASR bench,
 * and the real-audio FFI test so all three agree on what "well-formed" means.
 */
export function validateAsrWordTimings(
  words: ReadonlyArray<TranscriptWord>,
  audioDurationMs = 0,
  toleranceMs = 1,
): WordTimingValidation {
  const violations: WordTimingViolation[] = [];
  let prevEndMs = 0;
  words.forEach((w, index) => {
    const word = w.text;
    if (typeof word !== "string" || word.trim().length === 0) {
      violations.push({ index, word: String(word), reason: "empty word text" });
    }
    if (!Number.isFinite(w.startMs) || !Number.isFinite(w.endMs)) {
      violations.push({ index, word, reason: "non-finite timing" });
      return;
    }
    if (w.startMs < -toleranceMs) {
      violations.push({ index, word, reason: `startMs ${w.startMs} < 0` });
    }
    if (w.endMs < w.startMs - toleranceMs) {
      violations.push({
        index,
        word,
        reason: `endMs ${w.endMs} precedes startMs ${w.startMs}`,
      });
    }
    if (w.startMs < prevEndMs - toleranceMs) {
      violations.push({
        index,
        word,
        reason: `startMs ${w.startMs} overlaps previous end ${prevEndMs}`,
      });
    }
    if (audioDurationMs > 0 && w.endMs > audioDurationMs + toleranceMs) {
      violations.push({
        index,
        word,
        reason: `endMs ${w.endMs} exceeds audio duration ${audioDurationMs}`,
      });
    }
    prevEndMs = Math.max(prevEndMs, w.endMs);
  });
  return { ok: violations.length === 0, violations };
}
