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
/**
 * Words that never end a finished sentence. Every other continuation word
 * can: "I think so.", "I did.", "Turn the lights on.", "Maybe."
 */
const NEVER_SENTENCE_FINAL = new Set([
  "a",
  "an",
  "the",
  "and",
  "but",
  "or",
  "nor",
  "because",
  "although",
  "if",
  "unless",
  "whereas",
  "um",
  "uh",
  "uhh",
  "umm",
  "erm",
  "er",
  "hmm",
  "hm",
  // Prepositions that need an object to close a clause. The prepositions that
  // can end a sentence ("Turn the lights on.", "Who is it for.", "What are you
  // thinking about.", "That's what I was thinking of.", "I'd love to.") stay
  // out of this set, so those answers keep 0.95.
  "between",
  "into",
  "during",
  "via",
]);
/**
 * A decimal point needs a preceding number, unlike "that's the point". "One
 * point" is also a finished phrase ("at one point", "won by one point"), so it
 * only reads as a decimal without a full stop or after another number word
 * ("twenty one point").
 */
const NUMBER_BEFORE_POINT =
  /^(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-(?:one|two|three|four|five|six|seven|eight|nine))?|hundred|thousand|million|billion)$/;
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
 *   4  Unfinished number ("1,", "$", "45 point", and         0.20  (mid-amount)
 *      "one point" without a full stop)
 *   5  Sentence-final full stop, unless the last word can    0.95
 *      never end a sentence (the / and / um / …)
 *   6  Trailing conjunction (and / but / because / …)       0.15  (mid-clause)
 *   7  Trailing filler / hedge (um / uh / maybe / …)        0.20  (holding floor)
 *   8  Trailing preposition / article (to / the / with …)   0.20  (incomplete NP)
 *   9  Dangling modal/auxiliary (could / would / is / …)    0.20  (incomplete clause)
 *  10  Short utterance (< 3 words, no trail-off)            0.70  (command/ack)
 *  11  No signal                                            0.50
 *
 * Speech recognizers add a full stop to most results, including ones cut off
 * mid-clause ("I want to pay the."). A final "." therefore does not end the
 * turn when the word before it never ends a sentence, but it does end a
 * finished answer whose last word only sometimes trails off ("I think so.",
 * "Yes I can.", "Turn the lights on."). The continuation checks precede the
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
  for (const tag of QUESTION_TAGS) {
    if (text.toLowerCase().endsWith(tag)) return 0.85;
  }
  // A final full stop is often the recognizer's, not the speaker's, so it is
  // set aside here and weighed against the last word below.
  const fullStop = text.endsWith(".");
  const body = fullStop ? text.slice(0, -1).trimEnd() : text;
  // An amount cut off mid-number ("1,", "$") — before the words lose punctuation.
  if (/(\d,|\$)$/.test(body)) return 0.2;
  const words = body
    .replace(/[^a-z0-9'\s-]/gi, "")
    .split(/\s+/)
    .filter(Boolean)
    // A capital "A" is the letter ("option A", "vitamin A"), not the article.
    .map((word) => (word === "A" ? word : word.toLowerCase()));
  if (words.length === 0) return fullStop ? 0.95 : 0.5;
  const lastWord = trimEndCharacters(words[words.length - 1], "',;:-");
  // A decimal point cut off before its digits ("45 point", "one point").
  // "One point" alone is finished, but not as the end of "twenty one point".
  const beforeLast = words.at(-2) ?? "";
  if (
    lastWord === "point" &&
    NUMBER_BEFORE_POINT.test(beforeLast) &&
    !(
      fullStop &&
      (beforeLast === "one" || beforeLast === "1") &&
      !NUMBER_BEFORE_POINT.test(words.at(-3) ?? "")
    )
  )
    return 0.2;
  if (fullStop && !NEVER_SENTENCE_FINAL.has(lastWord)) return 0.95;
  // Trailing conjunction / filler / incomplete phrase → mid-clause, the speaker
  // is continuing. Checked BEFORE the short-utterance rule so a 2-word trail-off
  // ("going to", "and so", "we could") is NOT misread as a complete command.
  if (TRAILING_CONJUNCTIONS.has(lastWord)) return 0.15;
  if (TRAILING_FILLERS.has(lastWord)) return 0.2;
  if (TRAILING_INCOMPLETE.has(lastWord)) return 0.2;
  if (TRAILING_CONTINUATIONS.has(lastWord)) return 0.2;
  // Short utterance that doesn't trail off (a command / acknowledgement) →
  // likely complete ("go home", "yes", "stop").
  if (words.length < 3) return 0.7;
  // No strong signal either way — the recognizer's silence is enough.
  return 0.5;
}
