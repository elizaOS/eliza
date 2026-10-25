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

/** A whitespace word of the transcript, plus the offsets needed to read the
 * user's own words back out of it. */
interface SourceWord {
  /** The word exactly as written (original case, punctuation and width). */
  source: string;
  /** Index in the transcript just past this word. */
  sourceEnd: number;
  /** `normalizeForWake(source)` — the matching currency. */
  normalized: string;
  /** `normalized` minus the spaces {@link tokenize} splits on. */
  chunk: string;
}

/**
 * Split the transcript into whitespace words and normalize each one.
 * Normalizing word by word is equivalent to normalizing the whole string: the
 * pipeline strips the Latin/Greek/Cyrillic combining block BEFORE NFKC
 * recomposition, and recomposition cannot span the whitespace between words.
 */
function sourceWords(text: string): SourceWord[] {
  const words: SourceWord[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const normalized = normalizeForWake(match[0]);
    words.push({
      source: match[0],
      sourceEnd: (match.index ?? 0) + match[0].length,
      normalized,
      chunk: normalized.replace(/ /g, ""),
    });
  }
  return words;
}

/**
 * Flatten the words into the normalized token stream the matcher works on,
 * remembering the source offset just past each token. Punctuation may split
 * one source word into a name and command (`Eliza,turn`), so the whitespace
 * word end cannot stand in for each token end.
 */
function tokensFromWords(words: SourceWord[]): {
  tokens: string[];
  sourceEnds: number[];
} {
  const tokens: string[] = [];
  const sourceEnds: number[] = [];
  for (const word of words) {
    if (!word.normalized.length) continue;
    let normalizedEnd = 0;
    for (const token of word.normalized.split(" ")) {
      normalizedEnd += token.length;
      tokens.push(token);
      sourceEnds.push(
        word.sourceEnd -
          word.source.length +
          sourceOffsetForNormalized(word, normalizedEnd),
      );
      normalizedEnd += 1;
    }
  }
  return { tokens, sourceEnds };
}

/**
 * The source offset just past the first `normalizedOffset` characters of
 * `word.normalized`. Normalization can change length (`é` → `e`, `ｴﾘｻﾞ` →
 * `エリザ`), so a normalized offset cannot index the source directly; walk
 * source code points until their normalization equals the target prefix.
 */
function sourceOffsetForNormalized(
  word: SourceWord,
  normalizedOffset: number,
): number {
  if (normalizedOffset <= 0) return 0;
  if (normalizedOffset >= word.normalized.length) return word.source.length;
  const target = word.normalized.slice(0, normalizedOffset);
  let source = 0;
  for (const ch of word.source) {
    source += ch.length;
    if (normalizeForWake(word.source.slice(0, source)) === target) {
      // Accent folding can match before the name's trailing combining marks.
      // Keep those marks with the name rather than leaking them into the command.
      for (const trailing of word.source.slice(source)) {
        if (!/\p{M}/u.test(trailing)) break;
        const end = source + trailing.length;
        if (normalizeForWake(word.source.slice(0, end)) !== target) break;
        source = end;
      }
      return source;
    }
  }
  return word.source.length;
}

/**
 * The source offset just past the first `chunkOffset` characters of
 * `word.chunk`, accounting for the spaces tokenization inserted where the
 * source carried punctuation (`what's` → chunk `whats`).
 */
function sourceOffsetForChunk(word: SourceWord, chunkOffset: number): number {
  if (chunkOffset <= 0) return 0;
  if (chunkOffset >= word.chunk.length) return word.source.length;
  let seen = 0;
  let normalizedOffset = 0;
  for (const ch of word.normalized) {
    normalizedOffset += ch.length;
    if (ch === " ") continue;
    seen += 1;
    if (seen === chunkOffset) break;
  }
  return sourceOffsetForNormalized(word, normalizedOffset);
}

/**
 * The source offset just past a match ending at `matchEnd` in the space-less
 * haystack the fallback searches. A word whose chunk is empty (an emoji-only
 * word, say) contributes no haystack characters, so it coincides with its
 * predecessor's end.
 */
function sourceOffsetAfterMatch(words: SourceWord[], matchEnd: number): number {
  let cursor = 0;
  for (const word of words) {
    const next = cursor + word.chunk.length;
    if (matchEnd <= next) {
      const wordStart = word.sourceEnd - word.source.length;
      return matchEnd <= cursor
        ? wordStart
        : wordStart + sourceOffsetForChunk(word, matchEnd - cursor);
    }
    cursor = next;
  }
  return words.length ? words[words.length - 1].sourceEnd : 0;
}

/**
 * The command that follows the matched name, read from the ORIGINAL transcript
 * so the agent receives the user's own words: `"hey Eliza what's the weather in
 * St. Louis?"` yields `"what's the weather in St. Louis?"`, not the normalized
 * `"what s the weather in st louis"`. This is also what the caller records as
 * the turn's transcript, so the two no longer disagree. Separators the name
 * abuts (`"Eliza, do it"`) are dropped.
 */
function commandInTranscript(transcript: string, sourceOffset: number): string {
  return (
    transcript
      .slice(sourceOffset)
      .replace(/^(?:['’]s\b|['’])\s*/iu, "")
      // Remove speech separators, preserving command symbols such as a minus,
      // currency sign, quotation mark, hashtag, or emoji.
      .replace(/^[\s,.:;!?、，。：；！？—–]+/u, "")
      .trimEnd()
  );
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
  const words = sourceWords(transcript);
  if (!words.length) return NO_MATCH;
  const { tokens, sourceEnds } = tokensFromWords(words);
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
      const command = commandInTranscript(transcript, sourceEnds[hit.end - 1]);
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
    const haystack = words.map((word) => word.chunk).join("");
    const at = haystack.indexOf(joinedName);
    if (at !== -1) {
      const command = commandInTranscript(
        transcript,
        sourceOffsetAfterMatch(words, at + joinedName.length),
      );
      return { matched: true, command, distance: 0 };
    }
  }
  return NO_MATCH;
}
