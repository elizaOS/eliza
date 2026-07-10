/**
 * Audio PII redaction — span production (#14807).
 *
 * Pure, browser- + node-safe span math for the corpus PII scrub's audio lane:
 * text-PII verdicts (the matched surface strings from the tier-0 detectors /
 * `PII_SCRUB` model verdicts) are located inside a timed-ASR word stream
 * ({@link TranscriptWord}, ms from audio start — the same contract the
 * transcript player uses) and turned into padded, merged, non-overlapping
 * `[{startMs, endMs}]` windows an executor (pure-TS WAV zeroing or ffmpeg
 * `volume=0:enable=…`) can mute or bleep.
 *
 * Design constraints this module honors:
 *
 *  - **Raw word spans in, no anchor seam dependency.** Input is the raw timed
 *    ASR word list (any producer that satisfies the {@link TranscriptWord}
 *    contract — fused `eliza_inference_asr_transcribe_timed`, an
 *    OpenAI-compatible STT with `timestamp_granularities=word`, …), not a
 *    transcript-fragment anchor record.
 *  - **Fail-closed on unlocatable PII.** A PII span that cannot be located in
 *    the word stream is returned in `unmatched` — the caller MUST treat a
 *    non-empty `unmatched` as a hard failure (typed error, quarantined item),
 *    never as "nothing to mute". Silence here would leak audible PII.
 *  - **Over-redaction is the safe direction.** Matching is
 *    separator-insensitive (normalized concatenation), so "555 0123" in the
 *    verdict matches an ASR word "5550123." and vice versa; a rare over-broad
 *    match mutes a little extra audio, never leaks any.
 *  - **Labels are plain input.** Pseudonym/cluster labels (corpus map,
 *    #14805) ride through untouched for observability; they never influence
 *    the produced windows.
 *
 * The re-transcribe verifier is deliberately a SEPARATE module
 * (`audio-redaction-verify.ts`) with its own provider contract, so the span
 * producer and the verifier can run on different ASR backends (see the
 * acceptance note on #14807).
 */

import type { TranscriptWord } from "./transcripts";

/** One redaction window, ms from audio start (same clock as word timings). */
export interface AudioRedactionSpan {
  startMs: number;
  endMs: number;
  /** Pseudonym/cluster labels of the PII that produced this window (audit). */
  labels?: readonly string[];
}

/** One text-PII verdict to locate in the word stream. */
export interface PiiTextSpan {
  /** The matched PII surface text (`Tier0Span.span` / `PiiScrubVerdict.span`). */
  text: string;
  /** Pseudonym/cluster label from the corpus map (#14805) — plain input. */
  label?: string;
}

/**
 * Default padding applied to each side of a matched window. Empirically
 * calibrated on a live TTS fixture + faster-whisper word timings: at 150 ms a
 * boundary fragment of a planted phone number ("five…") survived the mute and
 * was re-transcribed as a stray digit; at 250–300 ms the re-transcription
 * carried no PII fragment at all (only non-PII filler hallucinated over the
 * gap). ASR word boundaries are estimates — pad generously.
 */
export const DEFAULT_REDACTION_PAD_MS = 250;

/** Thrown for structurally invalid span input (fail-closed, never dropped). */
export class RedactionSpanError extends Error {
  constructor(message: string) {
    super(`audio redaction span invalid: ${message}`);
    this.name = "RedactionSpanError";
  }
}

/**
 * Normalize spoken text for separator-insensitive matching: lowercase and
 * strip everything that is not a Unicode letter or digit. `"555 0123."` and
 * `" 5550123"` both normalize to `"5550123"`.
 */
export function normalizeSpokenText(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

interface NormalizedWordStream {
  /** Time-ordered words with non-empty normalized text. */
  words: TranscriptWord[];
  /** Concatenated normalized word text (no separators). */
  concat: string;
  /** `concat[i]` came from `words[charToWord[i]]`. */
  charToWord: number[];
}

/**
 * Sort words by time (tolerates out-of-order producer output), normalize each
 * word, and build the concatenated search text with a char→word index map.
 * Words whose text normalizes to empty (pure punctuation) contribute nothing.
 */
function buildWordStream(
  words: readonly TranscriptWord[],
): NormalizedWordStream {
  const ordered = [...words].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );
  const kept: TranscriptWord[] = [];
  const charToWord: number[] = [];
  let concat = "";
  for (const word of ordered) {
    if (!Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)) {
      throw new RedactionSpanError(
        `word "${word.text}" has non-finite timing (${word.startMs}..${word.endMs})`,
      );
    }
    if (word.endMs < word.startMs) {
      throw new RedactionSpanError(
        `word "${word.text}" ends (${word.endMs}) before it starts (${word.startMs})`,
      );
    }
    const normalized = normalizeSpokenText(word.text);
    if (normalized.length === 0) continue;
    const wordIndex = kept.length;
    kept.push(word);
    for (let i = 0; i < normalized.length; i += 1) charToWord.push(wordIndex);
    concat += normalized;
  }
  return { words: kept, concat, charToWord };
}

/** Result of locating text-PII verdicts inside the word stream. */
export interface PiiSpanMatchResult {
  /** One raw (unpadded, unmerged) window per located occurrence. */
  matches: AudioRedactionSpan[];
  /**
   * PII spans that could NOT be located in the word stream. Non-empty means
   * the redaction job MUST fail typed/observable — audible PII would survive.
   */
  unmatched: PiiTextSpan[];
}

/**
 * Locate every occurrence of each text-PII span inside the timed word stream
 * and emit one `[startMs, endMs]` window per occurrence (first matched word's
 * start → last matched word's end). Matching is separator-insensitive in both
 * directions: a verdict spanning several ASR words ("John Smith") and an ASR
 * word fusing several verdict tokens ("5550123.") both match. ALL occurrences
 * are windowed — a name spoken three times is muted three times.
 */
export function matchPiiSpansToWords(
  words: readonly TranscriptWord[],
  piiSpans: readonly PiiTextSpan[],
): PiiSpanMatchResult {
  const stream = buildWordStream(words);
  const matches: AudioRedactionSpan[] = [];
  const unmatched: PiiTextSpan[] = [];
  for (const pii of piiSpans) {
    const needle = normalizeSpokenText(pii.text);
    if (needle.length === 0) {
      unmatched.push(pii);
      continue;
    }
    let found = false;
    let from = 0;
    while (from <= stream.concat.length - needle.length) {
      const at = stream.concat.indexOf(needle, from);
      if (at === -1) break;
      found = true;
      const firstWord = stream.words[stream.charToWord[at]];
      const lastWord = stream.words[stream.charToWord[at + needle.length - 1]];
      matches.push({
        startMs: firstWord.startMs,
        endMs: lastWord.endMs,
        ...(pii.label !== undefined ? { labels: [pii.label] } : {}),
      });
      from = at + 1;
    }
    if (!found) unmatched.push(pii);
  }
  return { matches, unmatched };
}

/** Options for {@link mergeRedactionSpans}. */
export interface MergeRedactionSpanOptions {
  /**
   * Audio duration in ms — windows are clamped to `[0, durationMs]`. Pass `0`
   * to skip the upper clamp (mirrors `validateAsrWordTimings`).
   */
  durationMs: number;
  /** Padding added to each side of every window before merging. */
  padMs?: number;
  /**
   * Two windows closer than this merge into one (avoids leaving unmutable
   * slivers between adjacent PII words). `0` still merges touching windows.
   */
  mergeGapMs?: number;
}

/**
 * Pad, clamp, sort, and merge raw windows into a non-overlapping ascending
 * list of integer-ms redaction spans. Overlapping, adjacent, and contained
 * windows collapse; labels of merged windows union. Malformed input
 * (non-finite, negative length) THROWS — a silently dropped window would leak
 * audible PII. Windows that fall entirely outside `[0, durationMs]` after
 * clamping are dropped (there is no audio there to mute).
 */
export function mergeRedactionSpans(
  spans: readonly AudioRedactionSpan[],
  options: MergeRedactionSpanOptions,
): AudioRedactionSpan[] {
  const padMs = options.padMs ?? DEFAULT_REDACTION_PAD_MS;
  const mergeGapMs = options.mergeGapMs ?? 0;
  const durationMs = options.durationMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RedactionSpanError(`durationMs ${durationMs} is not valid`);
  }
  if (!Number.isFinite(padMs) || padMs < 0) {
    throw new RedactionSpanError(`padMs ${padMs} is not valid`);
  }
  if (!Number.isFinite(mergeGapMs) || mergeGapMs < 0) {
    throw new RedactionSpanError(`mergeGapMs ${mergeGapMs} is not valid`);
  }

  const padded: AudioRedactionSpan[] = [];
  for (const span of spans) {
    if (!Number.isFinite(span.startMs) || !Number.isFinite(span.endMs)) {
      throw new RedactionSpanError(
        `span has non-finite bounds (${span.startMs}..${span.endMs})`,
      );
    }
    if (span.endMs < span.startMs) {
      throw new RedactionSpanError(
        `span ends (${span.endMs}) before it starts (${span.startMs})`,
      );
    }
    let start = Math.floor(span.startMs - padMs);
    let end = Math.ceil(span.endMs + padMs);
    // Clamp to the audio: padding at the file edges must not produce negative
    // or past-the-end coordinates the executor would reject.
    if (start < 0) start = 0;
    if (durationMs > 0 && end > durationMs) end = Math.ceil(durationMs);
    if (durationMs > 0 && start >= durationMs) continue; // fully past the end
    if (end <= start) continue; // zero-length after pad+clamp: nothing to mute
    padded.push({
      startMs: start,
      endMs: end,
      ...(span.labels && span.labels.length > 0
        ? { labels: [...span.labels] }
        : {}),
    });
  }

  padded.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: Array<{ startMs: number; endMs: number; labels: Set<string> }> =
    [];
  for (const span of padded) {
    const last = merged[merged.length - 1];
    if (last && span.startMs <= last.endMs + mergeGapMs) {
      last.endMs = Math.max(last.endMs, span.endMs);
      for (const label of span.labels ?? []) last.labels.add(label);
      continue;
    }
    merged.push({
      startMs: span.startMs,
      endMs: span.endMs,
      labels: new Set(span.labels ?? []),
    });
  }

  return merged.map((span) => ({
    startMs: span.startMs,
    endMs: span.endMs,
    ...(span.labels.size > 0 ? { labels: [...span.labels].sort() } : {}),
  }));
}

/** Options for {@link buildAudioRedactionSpans}. */
export interface BuildRedactionSpanOptions
  extends Omit<MergeRedactionSpanOptions, "durationMs"> {
  durationMs: number;
}

/** Result of the full text-PII → timestamp-window derivation. */
export interface AudioRedactionSpanPlan {
  /** Padded, merged, non-overlapping windows ready for the executor. */
  spans: AudioRedactionSpan[];
  /** Raw per-occurrence matches before pad/merge (audit trail). */
  matches: AudioRedactionSpan[];
  /** PII spans not locatable in the word stream — MUST fail the job if set. */
  unmatched: PiiTextSpan[];
}

/**
 * Full pipeline step: locate text-PII verdicts in the timed word stream, then
 * pad + merge into executor-ready windows. The caller owns the fail-closed
 * decision on `unmatched` (throw typed, quarantine the item) — this module
 * only guarantees it is never silently empty when PII could not be located.
 */
export function buildAudioRedactionSpans(
  words: readonly TranscriptWord[],
  piiSpans: readonly PiiTextSpan[],
  options: BuildRedactionSpanOptions,
): AudioRedactionSpanPlan {
  const { matches, unmatched } = matchPiiSpansToWords(words, piiSpans);
  const spans = mergeRedactionSpans(matches, options);
  return { spans, matches, unmatched };
}
