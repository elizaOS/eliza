/**
 * Transcription-mode exit-phrase detection.
 *
 * Long-form transcription mode records every utterance into the conversation
 * while the agent stays silent (see issue #8789 / the `core.transcription_mode`
 * server evaluator). The user leaves the mode by saying an exit phrase, after
 * which normal response evaluation resumes. This module is the pure, UI-side
 * detector the capture loop runs on every final transcript before sending.
 *
 * Two triggers (per product):
 *   1. An explicit phrase anywhere in the utterance — "exit transcription mode",
 *      "stop transcription", "end transcription", etc.
 *   2. A standalone SHORT utterance whose tokens include one of
 *      transcribe/transcription/transcribing/stop/exit. The short-utterance gate
 *      (≤ {@link MAX_STANDALONE_TOKENS} tokens) keeps a long sentence that merely
 *      contains "stop" (e.g. "I waited at the bus stop for ages") from exiting.
 */

/** Explicit multi-word exit phrases (substring match, punctuation-insensitive). */
const EXIT_PHRASES: readonly string[] = [
  "exit transcription mode",
  "stop transcription mode",
  "end transcription mode",
  "exit transcription",
  "stop transcription",
  "end transcription",
  "stop transcribing",
  "exit transcribe",
  "stop transcribe",
];

/** Tokens that, in a short standalone utterance, end transcription mode. */
const STANDALONE_EXIT_KEYWORDS: ReadonlySet<string> = new Set([
  "transcribe",
  "transcription",
  "transcribing",
  "stop",
  "exit",
]);

/** Max token count for the "standalone keyword" trigger (avoids false hits on
 *  long sentences that merely contain a keyword). */
export const MAX_STANDALONE_TOKENS = 4;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(normalized: string): string[] {
  return normalized.length > 0 ? normalized.split(" ") : [];
}

/** True when `text` should turn transcription mode OFF. */
export function isTranscriptionExitPhrase(
  text: string | null | undefined,
): boolean {
  const normalized = normalize(text ?? "");
  if (!normalized) return false;
  if (EXIT_PHRASES.some((phrase) => normalized.includes(phrase))) {
    return true;
  }
  const tokens = tokenize(normalized);
  return (
    tokens.length > 0 &&
    tokens.length <= MAX_STANDALONE_TOKENS &&
    tokens.some((token) => STANDALONE_EXIT_KEYWORDS.has(token))
  );
}

/**
 * Return the non-exit text that PRECEDES the exit phrase (to be committed as a
 * final transcription turn). For an explicit phrase, returns everything before
 * it. For a bare standalone-keyword utterance (no explicit phrase), there is no
 * meaningful preceding content in a ≤4-token utterance, so returns "".
 * Returns the original (trimmed) text when no exit was detected.
 */
export function stripExitPhrase(text: string | null | undefined): string {
  const raw = text ?? "";
  if (!raw.trim()) return "";
  const lower = raw.toLowerCase();
  let cut = -1;
  for (const phrase of EXIT_PHRASES) {
    const at = lower.indexOf(phrase);
    if (at >= 0 && (cut === -1 || at < cut)) cut = at;
  }
  if (cut >= 0) return raw.slice(0, cut).trim();
  if (isTranscriptionExitPhrase(raw)) return "";
  return raw.trim();
}
