/**
 * Name-aware wake-phrase matching.
 *
 * The wake word follows the CHARACTER NAME (the user can rename the character in
 * settings — "hey eliza" becomes "hey ada"). Because the openWakeWord head is
 * trained per-phrase and is not zero-shot, an arbitrary renamed name is matched
 * at the confirmation stage by running short ASR and fuzzy-matching the
 * transcript against the current name here (see VOICE_UX.md, issue #9880). The
 * same matcher backs the Swabble trigger list and the transcript-mode inline
 * reply detector, so every surface agrees on what counts as "the wake word".
 *
 * Pure + deterministic: tokenise, allow an optional wake prefix ("hey" / "ok" /
 * …), then Levenshtein-match the next token(s) against the name within a
 * length-derived tolerance so ASR slop and homophones ("elisa", "a liza") still
 * fire while unrelated words ("hey there") do not. Returns the command text that
 * follows the name so a wake utterance can carry its request in one breath
 * ("hey eliza what's the weather" → command "what's the weather").
 */

export interface WakeNameMatch {
  /** True when the transcript contains the wake phrase for `name`. */
  matched: boolean;
  /** Text following the matched name ("" when the name ends the utterance). */
  command: string;
  /** Total edit distance of the matched name tokens (0 = exact). */
  distance: number;
}

export interface WakeNameMatchOptions {
  /**
   * Max total Levenshtein distance tolerated across the name tokens. Defaults to
   * a length-derived budget: floor(nameLen / 4), clamped to [1, 3].
   */
  maxDistance?: number;
  /**
   * Require a wake prefix ("hey", "ok", …) before the name. Default false — a
   * bare name is allowed only when it is long enough (≥ 4 chars) to be
   * distinctive, mirroring how the transcription-exit keyword gate avoids short
   * false positives.
   */
  requirePrefix?: boolean;
}

const NO_MATCH: WakeNameMatch = { matched: false, command: "", distance: 0 };

/**
 * Scripts that do not separate words with spaces (CJK ideographs, Japanese kana,
 * Korean hangul). Names in these scripts use the substring match path.
 */
const NON_SEGMENTING =
  /[\u3000-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/u;

/** Optional words that may precede the name in a wake phrase. */
const WAKE_PREFIXES = new Set([
  "hey",
  "hi",
  "hello",
  "ok",
  "okay",
  "yo",
  "hej",
  "hallo",
]);

/**
 * Lowercase, fold Latin accents, strip punctuation/symbols, and collapse
 * whitespace — while PRESERVING letters and digits of every script. Unicode-aware
 * so a renamed character in any language (Cyrillic "Эльза", CJK "エリザ", Arabic
 * "أليزا") survives normalization instead of being erased to "" (issue #9880).
 * Latin behaviour is unchanged.
 */
export function normalizeForWake(text: string): string {
  return (
    text
      .normalize("NFKD")
      // Fold ONLY the Latin/Greek/Cyrillic accent block (é→e). This deliberately
      // does not touch the Japanese voiced mark or Arabic harakat, which change
      // meaning rather than decorate it.
      .replace(/[̀-ͯ]/g, "")
      // Recompose so a decomposed kana (サ + U+3099) rejoins into ザ instead of
      // leaving a stray combining mark that the symbol-strip would delete.
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

function tokenize(text: string): string[] {
  const n = normalizeForWake(text);
  return n.length ? n.split(" ") : [];
}

/** Classic iterative Levenshtein distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Try to match `name` (possibly multi-token) against transcript tokens starting
 * at `start`, optionally consuming a wake prefix first. Returns the matched
 * token span end + distance, or null.
 */
function matchAt(
  tokens: string[],
  start: number,
  nameTokens: string[],
  budget: number,
  requirePrefix: boolean,
  bareAllowed: boolean,
): { end: number; distance: number; hadPrefix: boolean } | null {
  let i = start;
  const hadPrefix = WAKE_PREFIXES.has(tokens[i] ?? "");
  if (hadPrefix) i += 1;
  if (requirePrefix && !hadPrefix) return null;
  if (!hadPrefix && !bareAllowed) return null;

  // Match each name token against the corresponding transcript token, sharing
  // one distance budget across all of them.
  let distance = 0;
  for (let k = 0; k < nameTokens.length; k++) {
    const tok = tokens[i + k];
    if (tok === undefined) return null;
    distance += levenshtein(tok, nameTokens[k]);
    if (distance > budget) return null;
  }
  return { end: i + nameTokens.length, distance, hadPrefix };
}

/**
 * Match a wake phrase for `name` anywhere in `transcript`. Prefers the earliest
 * occurrence; returns the trailing command text.
 */
export function matchWakeName(
  transcript: string,
  name: string,
  options: WakeNameMatchOptions = {},
): WakeNameMatch {
  const nameTokens = tokenize(name);
  if (!nameTokens.length) return NO_MATCH;
  const tokens = tokenize(transcript);
  if (!tokens.length) return NO_MATCH;

  const nameLen = nameTokens.join("").length;
  const budget =
    options.maxDistance ?? Math.min(3, Math.max(1, Math.floor(nameLen / 4)));
  const requirePrefix = options.requirePrefix ?? false;
  // A bare (prefix-less) name only counts when it is distinctive enough.
  const bareAllowed = nameLen >= 4;

  for (let start = 0; start < tokens.length; start++) {
    const hit = matchAt(
      tokens,
      start,
      nameTokens,
      budget,
      requirePrefix,
      bareAllowed,
    );
    if (hit) {
      const command = tokens.slice(hit.end).join(" ");
      return { matched: true, command, distance: hit.distance };
    }
  }

  // Space-less scripts (CJK / kana / hangul) often glue the name to the rest of
  // the utterance with no separator, so token matching can't isolate it. For
  // those names, fall back to an exact substring search of the normalized
  // transcript. Gated to non-segmenting scripts so it never loosens Latin
  // matching (where it would create false positives like "al" inside "also").
  const joinedName = nameTokens.join("");
  if (NON_SEGMENTING.test(joinedName)) {
    const haystack = tokens.join("");
    const at = haystack.indexOf(joinedName);
    if (at !== -1) {
      const command = haystack.slice(at + joinedName.length).trim();
      return { matched: true, command, distance: 0 };
    }
  }
  return NO_MATCH;
}

/** Convenience boolean wrapper. */
export function isWakePhrase(
  transcript: string,
  name: string,
  options?: WakeNameMatchOptions,
): boolean {
  return matchWakeName(transcript, name, options).matched;
}
