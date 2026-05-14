/**
 * First-sentence snip helper for the TTS first-line cache.
 *
 * Pure, deterministic, no I/O. Both the local runtime and the Eliza Cloud
 * `/api/v1/voice/tts` route call into this module so that byte-equal sentence
 * text on either side maps to byte-equal cache keys.
 *
 * Algorithm summary (see R4 §2 in `.swarm/research/R4-tts-cache.md`):
 *   1. Trim leading whitespace.
 *   2. Walk char-by-char, tracking quote depth (skip terminators inside
 *      `"..."`/`'...'`/`“...”`), decimal context (digit-`.`-digit isn't a
 *      boundary), and abbreviation context (e.g. `Mr.`, `e.g.`, `U.S.`).
 *   3. First surviving terminator (`.`/`!`/`?`/`…`/`。`/`！`/`？`) or `\n`
 *      ends the sentence. Consume any contiguous run of terminators that
 *      follow (so `"Wait..."` stays intact).
 *   4. If no terminator and no newline → null (don't cache unterminated text).
 *   5. Apply ≤10-word filter on the normalised form. If wordCount > 10,
 *      return null (don't cache).
 *
 * `FIRST_SENTENCE_SNIP_VERSION` is part of the cache key — bumping it
 * invalidates every existing cached entry.
 */

/**
 * Cache-key algorithm version. Bump when the snip/normalise logic changes
 * in a way that would produce different keys for the same input. Local and
 * cloud caches re-key off this constant, so a bump rolls the entire cache.
 */
export const FIRST_SENTENCE_SNIP_VERSION = "1" as const;
export type FirstSentenceSnipVersion = typeof FIRST_SENTENCE_SNIP_VERSION;

/**
 * Maximum word count (Unicode-aware) for a cacheable first-sentence snip.
 * Beyond this the bytes won't repeat often enough to amortise the cache.
 */
export const FIRST_SENTENCE_MAX_WORDS = 10 as const;

const ABBREVIATIONS = new Set<string>([
  "mr",
  "mrs",
  "ms",
  "mx",
  "dr",
  "st",
  "jr",
  "sr",
  "prof",
  "vs",
  "etc",
  "eg",
  "ie",
  "fig",
  "no",
  "vol",
  "ch",
  "pt",
  "co",
  "inc",
  "ltd",
  "us",
  "uk",
  "usa",
]);

/**
 * Terminator chars that end a sentence. Includes CJK `。！？` so multilingual
 * inputs aren't refused.
 */
const TERMINATOR_REGEX = /[.!?…。！？]/u;

const QUOTE_PAIRS: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["«", "»"],
  ["「", "」"],
  ["『", "』"],
]);

const CLOSE_QUOTES: ReadonlySet<string> = new Set(QUOTE_PAIRS.values());

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isAlpha(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) // a-z
  );
}

/**
 * Lower-case + strip dots from a token to compare against `ABBREVIATIONS`.
 * Used to detect things like `Mr.` / `U.S.` / `e.g.` where the dot is part of
 * an abbreviation rather than a sentence terminator.
 */
function isAbbrevToken(token: string): boolean {
  if (token.length === 0 || token.length > 6) return false;
  const lower = token.toLowerCase().replace(/\./g, "");
  if (!lower) return false;
  return ABBREVIATIONS.has(lower);
}

/**
 * Walk the input forwards looking for the first sentence-terminating position.
 * Returns the *inclusive* end index of the terminator run (so the snip is
 * `text.slice(start, endInclusive + 1)`), or -1 if no terminator was found.
 *
 * `start` is the position after any leading whitespace.
 */
function findTerminatorEnd(text: string, start: number): number {
  let i = start;
  const quoteStack: string[] = [];

  while (i < text.length) {
    const ch = text[i] ?? "";

    // Newline acts as a soft terminator (e.g. message body broken into lines).
    if (ch === "\n") {
      // Strip trailing whitespace from the run by returning index of \n.
      return i;
    }

    // Open / close quotes for skipping terminators inside.
    const closer = QUOTE_PAIRS.get(ch);
    if (closer && closer !== ch) {
      // Asymmetric pair → push the expected closer.
      quoteStack.push(closer);
      i++;
      continue;
    }
    if (quoteStack.length > 0 && ch === quoteStack[quoteStack.length - 1]) {
      quoteStack.pop();
      i++;
      continue;
    }
    // Symmetric ASCII quotes: toggle stack only when not already inside an
    // asymmetric quote.
    //
    // Apostrophes (`'`) are NEVER treated as quote delimiters when they sit
    // between two letters (contractions like `it's`, possessives like
    // `Eliza's`) — otherwise a stray apostrophe would swallow the rest of
    // the input and we'd never find a terminator.
    if (ch === "'" && quoteStack.length === 0) {
      const prev = i > 0 ? text[i - 1] : "";
      const next = i + 1 < text.length ? text[i + 1] : "";
      if (!(isAlpha(prev) && isAlpha(next))) {
        quoteStack.push(ch);
      }
      i++;
      continue;
    }
    if (ch === '"' && quoteStack.length === 0) {
      quoteStack.push(ch);
      i++;
      continue;
    }
    if (
      quoteStack.length > 0 &&
      CLOSE_QUOTES.has(quoteStack[quoteStack.length - 1] ?? "") &&
      ch === quoteStack[quoteStack.length - 1]
    ) {
      quoteStack.pop();
      i++;
      continue;
    }

    // Skip everything inside quotes.
    if (quoteStack.length > 0) {
      i++;
      continue;
    }

    if (!TERMINATOR_REGEX.test(ch)) {
      i++;
      continue;
    }

    // Candidate terminator. Apply guards.
    if (ch === ".") {
      // Decimal context: digit . digit
      const prev = i > 0 ? text[i - 1] : "";
      const next = i + 1 < text.length ? text[i + 1] : "";
      if (isDigit(prev) && isDigit(next)) {
        i++;
        continue;
      }
      // Abbreviation context: look backwards for an alpha run, possibly
      // with internal dots (e.g. `U.S.`). Bound the look-back to 6 chars.
      let j = i - 1;
      let token = "";
      while (j >= 0 && j >= i - 6) {
        const tj = text[j] ?? "";
        if (isAlpha(tj) || tj === ".") {
          token = tj + token;
          j--;
          continue;
        }
        break;
      }
      if (token && isAbbrevToken(token)) {
        i++;
        continue;
      }
      // Also: avoid treating mid-word dot as terminator if followed
      // immediately by alpha and no whitespace (e.g. "foo.bar"
      // shouldn't terminate). Cache hit rate is more important than
      // being clever here — conservative: skip.
      if (isAlpha(next)) {
        i++;
        continue;
      }
    }

    // Valid terminator. Consume any contiguous run of terminator chars so
    // `Wait...` stays intact, then return the inclusive end.
    let end = i;
    while (end + 1 < text.length) {
      const nxt = text[end + 1] ?? "";
      if (TERMINATOR_REGEX.test(nxt)) {
        end++;
        continue;
      }
      break;
    }
    return end;
  }
  return -1;
}

/**
 * Unicode-aware word count. Hyphenated words and apostrophe-internal words
 * count as one (e.g. "twenty-three" → 1, "it's" → 1). Dotted acronyms with
 * single-letter segments (e.g. "U.S.", "U.S.A.") count as one word. Decimal
 * numbers like "3.14" count as one word.
 */
export function wordCount(s: string): number {
  if (!s) return 0;
  const matches = s.match(
    // In priority order:
    //   - decimal number (digits . digits, possibly multi-segment)
    //   - dotted acronym (≥2 single-letter dot pairs)
    //   - regular word with optional hyphen/apostrophe internal joiners
    /\p{N}+(?:\.\p{N}+)+|(?:\p{L}\.){2,}|[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu,
  );
  return matches ? matches.length : 0;
}

/**
 * Normalise a snip for cache-key purposes. NFC + lower-case + collapse
 * whitespace + strip trailing terminators/whitespace. Apostrophes preserved.
 */
export function normalizeForKey(snip: string): string {
  let s = snip.normalize("NFC");
  // Trim leading whitespace including zero-width space (U+200B).
  s = s.replace(/^[\s​]+/u, "").replace(/[\s​]+$/u, "");
  s = s.toLowerCase();
  s = s.replace(/\s+/gu, " ");
  // Strip trailing terminator/whitespace run. CJK terminators included.
  s = s.replace(/[\s​.!?…。！？]+$/gu, "");
  return s;
}

export interface FirstSentenceSnipResult {
  /** Raw snip including the terminator run, exactly as it appeared. */
  raw: string;
  /** Normalised form for cache-key hashing (`normalizeForKey(raw)`). */
  normalized: string;
  /** Unicode-aware word count over `normalized`. Always ≤ 10. */
  wordCount: number;
  /** End-exclusive offset into the original input where the snip ends. */
  endOffset: number;
}

/**
 * Attempt to snip the first sentence from `text`. Returns `null` if:
 *   - input is empty / whitespace only
 *   - no sentence-terminator found
 *   - normalised snip has > 10 words
 *   - normalised snip is empty after stripping terminators
 *
 * Otherwise returns a `FirstSentenceSnipResult` carrying the raw and
 * normalised forms plus the word count.
 */
export function firstSentenceSnip(
  text: string,
): FirstSentenceSnipResult | null {
  if (typeof text !== "string" || text.length === 0) return null;

  // Find start after leading whitespace (incl. zero-width space).
  const trimMatch = /^[\s​]+/u.exec(text);
  const start = trimMatch ? trimMatch[0].length : 0;
  if (start >= text.length) return null;

  const end = findTerminatorEnd(text, start);
  if (end < 0) return null;

  const raw = text.slice(start, end + 1);
  const normalized = normalizeForKey(raw);
  if (!normalized) return null;

  const wc = wordCount(normalized);
  if (wc === 0) return null;
  if (wc > FIRST_SENTENCE_MAX_WORDS) return null;

  return {
    raw,
    normalized,
    wordCount: wc,
    endOffset: end + 1,
  };
}
