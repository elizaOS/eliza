/**
 * Heuristic end-of-turn (EOT) scoring — the single source of truth (#8786).
 *
 * The semantic "is the speaker done?" syntactic heuristic used to be implemented
 * twice with drifted behavior: the UI shell capture path
 * (`packages/ui/src/voice/end-of-turn.ts:scoreEndOfTurn`) and the plugin's
 * Tier-3 classifier (`plugin-local-inference .../voice/eot-classifier.ts:
 * HeuristicEotClassifier`). The two had diverged — different rule ORDERING
 * (the plugin scored a 2-word trail-off like "and so" as a complete short
 * command; the UI correctly held it), a missing ellipsis rule on the plugin
 * side, and a different question-tag set. This module is the one canonical
 * implementation both surfaces consume.
 *
 * It lives in `@elizaos/shared` (which both already depend on), is pure +
 * browser-safe (no Node deps), and ships via the `@elizaos/shared/voice-eot`
 * subpath without pulling the whole barrel — mirroring `voice-wer`.
 *
 * The fused composite EOT (ABI v11, `CompositeEotClassifier`) is preferred when
 * the loaded native build wires the semantic model; it blends THIS heuristic as
 * its high-precision syntactic co-signal, so consolidating here also feeds the
 * model path one definition.
 */

/** Conjunctions that strongly suggest the speaker is mid-clause. */
const TRAILING_CONJUNCTIONS = new Set([
  "and",
  "but",
  "or",
  "nor",
  "yet",
  "so",
  "because",
  "although",
  "though",
  "while",
  "whereas",
  "if",
  "unless",
  "until",
  "since",
  "when",
  "where",
  "which",
  "that",
  "who",
  "whom",
  "whose",
]);

/** Prepositions / articles that imply an incomplete noun phrase follows. */
const TRAILING_INCOMPLETE = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "into",
  "about",
  "through",
  "between",
  "against",
  "during",
  "before",
  "after",
  "without",
  "under",
  "over",
  "above",
  "below",
  "around",
  "beside",
  "beyond",
  "like",
  "near",
  "past",
  "via",
]);

/**
 * Question-tag suffixes that end an utterance (matched case-insensitively).
 * The union of both prior surfaces: punctuated forms (the UI set) plus the
 * bare forms (`right` / `yeah` / `correct`) the plugin relied on for the
 * no-trailing-`?` case. A punctuated tag is also caught by the sentence-final
 * punctuation rule, which fires first.
 */
const QUESTION_TAGS = [
  "right?",
  "yeah?",
  "ok?",
  "okay?",
  "correct?",
  "hm?",
  "huh?",
  "eh?",
  "right",
  "yeah",
  "correct",
];

/**
 * Probability in [0,1] that `transcript` is a COMPLETE turn (the speaker is
 * done). High → commit; low → the utterance trails off, keep listening.
 *
 * Rules fire in priority order; the first match wins:
 *
 *   1  Trailing ellipsis ("…" / "..")                       0.20  (trail-off)
 *   2  Sentence-final punctuation (. ! ?)                   0.95
 *   3  Question-tag suffix ("right?", "yeah", "correct")    0.85
 *   4  Trailing conjunction (and / but / because / …)       0.15  (mid-clause)
 *   5  Trailing preposition / article (to / the / with …)   0.20  (incomplete NP)
 *   6  Short utterance (< 3 words, no trail-off)            0.70  (command/ack)
 *   7  No signal                                            0.50
 *
 * Note the conjunction/preposition checks precede the short-utterance rule so a
 * 2-word trail-off ("and so", "going to") is NOT misread as a complete short
 * command.
 */
export function scoreEndOfTurnHeuristic(transcript: string): number {
  const text = transcript.trim();
  if (text.length === 0) return 0.5;

  // A trailing ellipsis is the strongest trail-off signal — the speaker paused
  // mid-thought. Checked BEFORE sentence-final punctuation, since "..." ends in ".".
  if (/(\.{2,}|…)$/.test(text)) return 0.2;
  // Sentence-final punctuation → almost certainly done.
  if (/[.!?]$/.test(text)) return 0.95;

  const lower = text.toLowerCase();
  for (const tag of QUESTION_TAGS) {
    if (lower.endsWith(tag)) return 0.85;
  }

  const words = lower
    .replace(/[^a-z0-9'\s-]/gi, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 0.5;

  const lastWord = words[words.length - 1].replace(/[',;:-]+$/, "");
  // Trailing conjunction / preposition / article → mid-clause, the speaker is
  // continuing. Checked BEFORE the short-utterance rule so a 2-word trail-off
  // ("going to", "and so") is NOT misread as a complete short command.
  if (TRAILING_CONJUNCTIONS.has(lastWord)) return 0.15;
  if (TRAILING_INCOMPLETE.has(lastWord)) return 0.2;

  // Short utterance that doesn't trail off (a command / acknowledgement) →
  // likely complete ("go home", "yes", "stop").
  if (words.length < 3) return 0.7;

  // No strong signal either way — the recognizer's silence is enough.
  return 0.5;
}
