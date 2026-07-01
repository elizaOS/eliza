/**
 * Word-error-rate scoring — the single source of truth (#8785).
 *
 * Both the headless metric library (plugin-local-inference `e2e-harness.ts`) and
 * the headful self-test (ui `voice-selftest-harness.ts`) need WER; this used to
 * be implemented twice with subtly different normalization. It lives in
 * `@elizaos/shared` (which both already depend on) so there is exactly one
 * definition. Pure + browser-safe (no Node deps), so it ships in the UI bundle
 * via the `@elizaos/shared/voice-wer` subpath without pulling the whole barrel.
 */

/** Lowercase, strip punctuation (keep letters/numbers/apostrophes), collapse WS. */
export function normalizeWerText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Levenshtein word-error-rate of `hypothesis` against `reference`
 * (substitutions + insertions + deletions, divided by reference word count).
 * An empty reference scores 0 against an empty hypothesis, else 1.
 */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const refWords = normalizeWerText(reference).split(" ").filter(Boolean);
  const hypWords = normalizeWerText(hypothesis).split(" ").filter(Boolean);
  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1;

  const prev = Array.from({ length: hypWords.length + 1 }, (_, i) => i);
  const curr = new Array<number>(hypWords.length + 1).fill(0);
  for (let i = 1; i <= refWords.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= hypWords.length; j++) {
      const cost = refWords[i - 1] === hypWords[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j < curr.length; j++) prev[j] = curr[j];
  }
  return prev[hypWords.length] / refWords.length;
}
