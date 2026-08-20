/**
 * Bounds the timed-word stream that audio PII redaction walks before it
 * builds PII matches and picks over-mute sentinels. Aggregate limits protect
 * the shared matcher's normalized indexes and occurrence list, while sorted
 * sweeps keep sentinel overlap selection sub-quadratic. This helper is
 * importable without the runtime graph so hostile inputs can be proven in
 * isolation.
 */

export const MAX_AUDIO_REDACTION_WORDS = 100_000;
export const MAX_AUDIO_REDACTION_WORD_CHARS = 4_096;
export const MAX_AUDIO_REDACTION_RAW_CHARS = 4_194_304;
export const MAX_AUDIO_REDACTION_NORMALIZED_CHARS = 1_000_000;
export const MAX_AUDIO_REDACTION_PII_SPANS = 1_024;
export const MAX_AUDIO_REDACTION_PII_SPAN_CHARS = 4_096;
export const MAX_AUDIO_REDACTION_PII_NORMALIZED_CHARS = 262_144;
export const MAX_AUDIO_REDACTION_MATCH_CANDIDATES = 100_000;

export type AudioRedactionTimedWord = {
  text: string;
  startMs: number;
  endMs: number;
};

export type AudioRedactionPiiSpan = {
  text: string;
};

export class AudioRedactionWordBudgetError extends Error {
  readonly name = "AudioRedactionWordBudgetError";

  constructor(
    message: string,
    readonly code:
      | "AUDIO_REDACTION_UNBOUNDED"
      | "AUDIO_REDACTION_SENTINEL_UNAVAILABLE",
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type SentinelCandidate = {
  text: string;
  normalized: string;
  midpoint: number;
};

function normalizeSpokenText(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function intersects(
  word: AudioRedactionTimedWord,
  span: { startMs: number; endMs: number },
): boolean {
  return word.startMs < span.endMs && span.startMs < word.endMs;
}

function normalizedWordCharsWithinBudget(
  words: readonly AudioRedactionTimedWord[],
): number {
  if (words.length > MAX_AUDIO_REDACTION_WORDS) {
    throw new AudioRedactionWordBudgetError(
      `audio redaction timed-word stream exceeds ${MAX_AUDIO_REDACTION_WORDS} words`,
      "AUDIO_REDACTION_UNBOUNDED",
      {
        wordCount: words.length,
        maxWords: MAX_AUDIO_REDACTION_WORDS,
      },
    );
  }
  let rawChars = 0;
  let normalizedChars = 0;
  for (const word of words) {
    if (word.text.length > MAX_AUDIO_REDACTION_WORD_CHARS) {
      throw new AudioRedactionWordBudgetError(
        `audio redaction timed-word text exceeds ${MAX_AUDIO_REDACTION_WORD_CHARS} characters`,
        "AUDIO_REDACTION_UNBOUNDED",
        {
          wordChars: word.text.length,
          maxWordChars: MAX_AUDIO_REDACTION_WORD_CHARS,
        },
      );
    }
    rawChars += word.text.length;
    if (rawChars > MAX_AUDIO_REDACTION_RAW_CHARS) {
      throw new AudioRedactionWordBudgetError(
        `audio redaction raw timed-word stream exceeds ${MAX_AUDIO_REDACTION_RAW_CHARS} characters`,
        "AUDIO_REDACTION_UNBOUNDED",
        {
          rawChars,
          maxRawChars: MAX_AUDIO_REDACTION_RAW_CHARS,
        },
      );
    }
    normalizedChars += normalizeSpokenText(word.text).length;
    if (normalizedChars > MAX_AUDIO_REDACTION_NORMALIZED_CHARS) {
      throw new AudioRedactionWordBudgetError(
        `audio redaction normalized timed-word stream exceeds ${MAX_AUDIO_REDACTION_NORMALIZED_CHARS} characters`,
        "AUDIO_REDACTION_UNBOUNDED",
        {
          normalizedChars,
          maxNormalizedChars: MAX_AUDIO_REDACTION_NORMALIZED_CHARS,
        },
      );
    }
  }
  return normalizedChars;
}

export function assertAudioRedactionWordBudget(
  words: readonly AudioRedactionTimedWord[],
): void {
  normalizedWordCharsWithinBudget(words);
}

/**
 * Bounds matcher inputs before the shared span builder allocates its
 * normalized stream, character-to-word map, and per-occurrence match list.
 */
export function assertAudioRedactionInputBudget(
  words: readonly AudioRedactionTimedWord[],
  piiSpans: readonly AudioRedactionPiiSpan[],
): void {
  const normalizedWordChars = normalizedWordCharsWithinBudget(words);
  if (piiSpans.length > MAX_AUDIO_REDACTION_PII_SPANS) {
    throw new AudioRedactionWordBudgetError(
      `audio redaction PII stream exceeds ${MAX_AUDIO_REDACTION_PII_SPANS} spans`,
      "AUDIO_REDACTION_UNBOUNDED",
      {
        piiSpanCount: piiSpans.length,
        maxPiiSpans: MAX_AUDIO_REDACTION_PII_SPANS,
      },
    );
  }
  let normalizedPiiChars = 0;
  let matchCandidates = 0;
  for (const pii of piiSpans) {
    if (pii.text.length > MAX_AUDIO_REDACTION_PII_SPAN_CHARS) {
      throw new AudioRedactionWordBudgetError(
        `audio redaction PII text exceeds ${MAX_AUDIO_REDACTION_PII_SPAN_CHARS} characters`,
        "AUDIO_REDACTION_UNBOUNDED",
        {
          piiChars: pii.text.length,
          maxPiiChars: MAX_AUDIO_REDACTION_PII_SPAN_CHARS,
        },
      );
    }
    const normalizedLength = normalizeSpokenText(pii.text).length;
    normalizedPiiChars += normalizedLength;
    if (normalizedPiiChars > MAX_AUDIO_REDACTION_PII_NORMALIZED_CHARS) {
      throw new AudioRedactionWordBudgetError(
        `audio redaction normalized PII stream exceeds ${MAX_AUDIO_REDACTION_PII_NORMALIZED_CHARS} characters`,
        "AUDIO_REDACTION_UNBOUNDED",
        {
          normalizedPiiChars,
          maxNormalizedPiiChars: MAX_AUDIO_REDACTION_PII_NORMALIZED_CHARS,
        },
      );
    }
    if (normalizedLength > 0) {
      matchCandidates += Math.max(
        0,
        normalizedWordChars - normalizedLength + 1,
      );
      if (matchCandidates > MAX_AUDIO_REDACTION_MATCH_CANDIDATES) {
        throw new AudioRedactionWordBudgetError(
          `audio redaction matcher exceeds ${MAX_AUDIO_REDACTION_MATCH_CANDIDATES} possible occurrences`,
          "AUDIO_REDACTION_UNBOUNDED",
          {
            matchCandidates,
            maxMatchCandidates: MAX_AUDIO_REDACTION_MATCH_CANDIDATES,
          },
        );
      }
    }
  }
}

function uniqueSentinelCandidates(
  pool: readonly SentinelCandidate[],
): SentinelCandidate[] {
  const seen = new Set<string>();
  const unique: SentinelCandidate[] = [];
  for (const word of pool) {
    if (seen.has(word.normalized)) continue;
    seen.add(word.normalized);
    unique.push(word);
  }
  return unique;
}

export function selectAudioRedactionSentinels(
  words: readonly AudioRedactionTimedWord[],
  spans: readonly { startMs: number; endMs: number }[],
): string[] {
  assertAudioRedactionWordBudget(words);
  if (spans.length > MAX_AUDIO_REDACTION_MATCH_CANDIDATES) {
    throw new AudioRedactionWordBudgetError(
      `audio redaction plan exceeds ${MAX_AUDIO_REDACTION_MATCH_CANDIDATES} timed spans`,
      "AUDIO_REDACTION_UNBOUNDED",
      {
        spanCount: spans.length,
        maxSpans: MAX_AUDIO_REDACTION_MATCH_CANDIDATES,
      },
    );
  }
  const orderedSpans = [...spans].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );
  const orderedWords = [...words].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );
  const candidates: SentinelCandidate[] = [];
  let spanIndex = 0;
  for (const word of orderedWords) {
    while (
      spanIndex < orderedSpans.length &&
      orderedSpans[spanIndex].endMs <= word.startMs
    ) {
      spanIndex += 1;
    }
    const span = orderedSpans[spanIndex];
    if (span && intersects(word, span)) continue;
    const candidate = {
      text: word.text.trim(),
      normalized: normalizeSpokenText(word.text),
      midpoint: (word.startMs + word.endMs) / 2,
    };
    if (candidate.normalized.length > 0) candidates.push(candidate);
  }
  candidates.sort((a, b) => a.midpoint - b.midpoint);
  const preferred = candidates.filter((word) => word.normalized.length >= 3);
  const pool = preferred.length > 0 ? preferred : candidates;
  const unique = uniqueSentinelCandidates(pool);
  if (unique.length === 0) {
    throw new AudioRedactionWordBudgetError(
      "audio redaction has no non-PII timed word available as an over-mute sentinel",
      "AUDIO_REDACTION_SENTINEL_UNAVAILABLE",
    );
  }
  const positions =
    unique.length <= 3
      ? unique.map((_word, index) => index)
      : [0, Math.floor((unique.length - 1) / 2), unique.length - 1];
  return positions.map((index) => unique[index].text);
}
