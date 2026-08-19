/**
 * Bounds the timed-word stream that audio PII redaction walks before it
 * picks over-mute sentinels. Hostile STT can emit tens of thousands of
 * unique tokens; a `findIndex` uniqueness scan is quadratic on that list
 * and pins the agent event loop. This helper is importable without the
 * runtime graph so the hang can be proven in isolation.
 */

export const MAX_AUDIO_REDACTION_WORDS = 100_000;
export const MAX_AUDIO_REDACTION_WORD_CHARS = 4_096;

export type AudioRedactionTimedWord = {
  text: string;
  startMs: number;
  endMs: number;
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

export function assertAudioRedactionWordBudget(
  words: readonly AudioRedactionTimedWord[],
): void {
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
  const candidates = words
    .filter((word) => !spans.some((span) => intersects(word, span)))
    .map((word) => ({
      text: word.text.trim(),
      normalized: normalizeSpokenText(word.text),
      midpoint: (word.startMs + word.endMs) / 2,
    }))
    .filter((word) => word.normalized.length > 0)
    .sort((a, b) => a.midpoint - b.midpoint);
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
