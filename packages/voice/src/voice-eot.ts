/**
 * Browser-safe end-of-turn heuristic shared by UI capture and the Tier-3
 * classifier, exported through @elizaos/voice.
 * The native composite classifier also uses this syntactic signal alongside
 * its semantic model when that model is available.
 */
import { trimEndCharacters } from "@elizaos/core/speech";

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
/** Spoken fillers / hedges that usually mean the user is holding the floor. */
const TRAILING_FILLERS = new Set([
  "um",
  "uh",
  "uhh",
  "umm",
  "erm",
  "er",
  "hmm",
  "hm",
  "ah",
  "maybe",
]);
/** Number words that a spoken amount usually continues after ("two hundred…"). */
const TRAILING_NUMBER_WORDS = new Set([
  "point",
  "hundred",
  "thousand",
  "million",
  "billion",
]);
/** Dangling auxiliaries/modals that need another clause or phrase to land. */
const TRAILING_CONTINUATIONS = new Set([
  "am",
  "is",
  "are",
  "was",
  "were",
  "be",
  "being",
  "been",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
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
 *   2  Sentence-final ! or ?                                0.95
 *   3  Question-tag suffix ("right?", "yeah", "correct")    0.85
 *   4  Unfinished number ("1,", "$", "point", "hundred")    0.20  (mid-amount)
 *   5  Trailing conjunction (and / but / because / …)       0.15  (mid-clause)
 *   6  Trailing filler / hedge (um / uh / maybe / …)        0.20  (holding floor)
 *   7  Trailing preposition / article (to / the / with …)   0.20  (incomplete NP)
 *   8  Dangling modal/auxiliary (could / would / is / …)    0.20  (incomplete clause)
 *   9  Sentence-final full stop                             0.95
 *  10  Short utterance (< 3 words, no trail-off)            0.70  (command/ack)
 *  11  No signal                                            0.50
 *
 * Speech recognizers add a full stop to most results, including ones cut off
 * mid-clause ("I want to pay the."), so a single final "." is set aside and
 * the continuation checks run on the words before it; the full stop counts
 * only when none of them fire. The continuation checks also precede the
 * short-utterance rule so a 2-word trail-off ("and so", "going to", "we
 * could") is NOT misread as a complete short command.
 */
export function scoreEndOfTurnHeuristic(transcript: string): number {
  const text = transcript.trim();
  if (text.length === 0) return 0.5;
  // A trailing ellipsis is the strongest trail-off signal — the speaker paused
  // mid-thought. Checked BEFORE sentence-final punctuation, since "..." ends in ".".
  if (/(\.{2,}|…)$/.test(text)) return 0.2;
  // A final ! or ? → almost certainly done.
  if (/[!?]$/.test(text)) return 0.95;
  // A final full stop is often the recognizer's, not the speaker's: decide on
  // the words before it, and use it only when nothing says the turn goes on.
  const fullStop = text.endsWith(".");
  const lower = (fullStop ? text.slice(0, -1).trimEnd() : text).toLowerCase();
  for (const tag of QUESTION_TAGS) {
    if (lower.endsWith(tag)) return 0.85;
  }
  // An amount cut off mid-number ("1,", "$") — before the words lose punctuation.
  if (/(\d,|\$)$/.test(lower)) return 0.2;
  const words = lower
    .replace(/[^a-z0-9'\s-]/gi, "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 0.5;
  const lastWord = trimEndCharacters(words[words.length - 1], "',;:-");
  // Trailing conjunction / filler / incomplete phrase → mid-clause, the speaker
  // is continuing. Checked BEFORE the short-utterance rule so a 2-word trail-off
  // ("going to", "and so", "we could") is NOT misread as a complete command.
  if (TRAILING_NUMBER_WORDS.has(lastWord)) return 0.2;
  if (TRAILING_CONJUNCTIONS.has(lastWord)) return 0.15;
  if (TRAILING_FILLERS.has(lastWord)) return 0.2;
  if (TRAILING_INCOMPLETE.has(lastWord)) return 0.2;
  if (TRAILING_CONTINUATIONS.has(lastWord)) return 0.2;
  if (fullStop) return 0.95;
  // Short utterance that doesn't trail off (a command / acknowledgement) →
  // likely complete ("go home", "yes", "stop").
  if (words.length < 3) return 0.7;
  // No strong signal either way — the recognizer's silence is enough.
  return 0.5;
}
