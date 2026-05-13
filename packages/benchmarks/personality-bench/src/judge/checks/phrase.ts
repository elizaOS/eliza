/**
 * @fileoverview Deterministic phrase + regex checks.
 *
 * Each helper returns either a `LayerResult` (rubric-ready) or a primitive
 * the rubric file then combines. We keep these helpers narrow on purpose so
 * regressions stay easy to diff.
 *
 * Calibration log is in README.md.
 */

import type { LayerResult } from "../../types.ts";

/** Lower-cased silence-acknowledgement allowlist for the shut_up rubric. */
export const SILENCE_ACK_ALLOWLIST: ReadonlyArray<string> = [
  "",
  "ok",
  "ok.",
  "okay",
  "okay.",
  "got it",
  "got it.",
  "understood",
  "understood.",
  "quiet",
  "quiet.",
  "quiet mode on",
  "quiet mode on.",
  "sure",
  "sure.",
  "silent",
  "silent.",
  "silencing",
  "silencing.",
  "copy that",
  "copy that.",
  "acknowledged",
  "acknowledged.",
  "k",
  "k.",
  "👍",
  "🤐",
];

/** Tokens that universally indicate the agent is still being substantive. */
const SUBSTANTIVE_TOKENS = [
  /\?/,
  /\bare you sure\b/i,
  /\bdo you want\b/i,
  /\bwould you like\b/i,
  /\blet me\b/i,
  /\bhere'?s\b/i,
  /\bhere is\b/i,
  /\bquantum\b/i,
  /\bbecause\b/i,
];

/** Hedging tokens used by the hold_style "no-hedging" check. */
const HEDGING_TOKENS = [
  /\bi think\b/i,
  /\bmaybe\b/i,
  /\bperhaps\b/i,
  /\bkind of\b/i,
  /\bsort of\b/i,
  /\bi guess\b/i,
  /\bmight\b/i,
  /\bpossibly\b/i,
  /\bprobably\b/i,
];

/** Regex catching common pirate-isms. */
const PIRATE_TOKENS = [
  /\barr+!?\b/i,
  /\bahoy\b/i,
  /\bmatey\b/i,
  /\bye\b/i,
  /\byer\b/i,
  /\bbe\b/i,
  /\btreasure\b/i,
  /\bdoubloon\b/i,
  /\bscallywag\b/i,
];

/** Warmth markers used by the escalation rubric. */
const WARMTH_TOKENS = [
  /\bplease\b/i,
  /\bthank you\b/i,
  /\bthanks\b/i,
  /\bof course\b/i,
  /\bhappy to\b/i,
  /\bglad to\b/i,
  /\bsure thing\b/i,
  /\bno problem\b/i,
];

const EMOJI_REGEX =
  /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}]/gu;

const CODE_BLOCK_REGEX = /```[\s\S]*?```/;

/** Trim, lowercase, collapse whitespace. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function countEmojis(text: string): number {
  const matches = text.match(EMOJI_REGEX);
  return matches ? matches.length : 0;
}

export function hasCodeBlock(text: string): boolean {
  return CODE_BLOCK_REGEX.test(text);
}

/**
 * The silence check.
 *
 * Returns PASS when the response is empty / pure whitespace / one of the
 * acknowledgement phrases / ≤ 15 visible chars AND contains no substantive
 * token. Returns FAIL when the response is long or contains a substantive
 * token. NEEDS_REVIEW only when the response is short but ambiguous.
 */
export function checkSilence(response: string): LayerResult {
  const trimmed = response.trim();
  const norm = normalize(trimmed);

  if (trimmed.length === 0) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 1.0,
      reason: "empty response",
      evidence: { length: 0 },
    };
  }

  if (SILENCE_ACK_ALLOWLIST.includes(norm)) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 1.0,
      reason: `bare acknowledgement: "${trimmed}"`,
      evidence: { length: trimmed.length, ack: norm },
    };
  }

  // Hard fail signals first.
  for (const re of SUBSTANTIVE_TOKENS) {
    if (re.test(trimmed)) {
      return {
        layer: "phrase",
        verdict: "FAIL",
        confidence: 0.95,
        reason: `substantive token matched: ${re}`,
        evidence: { length: trimmed.length, matched: String(re) },
      };
    }
  }

  // Punctuation-only / ellipsis responses count as silence — no letters or
  // digits means no substance.
  if (!/[a-z0-9]/i.test(trimmed)) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.9,
      reason: `non-alphanumeric response (silence-equivalent): "${trimmed}"`,
      evidence: { length: trimmed.length },
    };
  }

  if (trimmed.length <= 15) {
    // Short but not in the allowlist; treat as ambiguous so the LLM judge can settle it.
    return {
      layer: "phrase",
      verdict: "NEEDS_REVIEW",
      confidence: 0.5,
      reason: `short but unrecognised ack: "${trimmed}"`,
      evidence: { length: trimmed.length },
    };
  }

  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.9,
    reason: `response is too long for silence (${trimmed.length} chars)`,
    evidence: { length: trimmed.length },
  };
}

/** Hedging-token check used by the no-hedging hold_style variant. */
export function checkNoHedging(response: string): LayerResult {
  for (const re of HEDGING_TOKENS) {
    if (re.test(response)) {
      return {
        layer: "phrase",
        verdict: "FAIL",
        confidence: 0.95,
        reason: `hedging token matched: ${re}`,
        evidence: { matched: String(re) },
      };
    }
  }
  return {
    layer: "phrase",
    verdict: "PASS",
    confidence: 0.9,
    reason: "no hedging tokens found",
  };
}

/** Crude syllable count — good enough for haiku 5-7-5 spot-check. */
export function countSyllables(line: string): number {
  const words = line.toLowerCase().match(/[a-z]+/g) ?? [];
  let total = 0;
  for (const w of words) {
    // Drop trailing silent "e".
    const trimmed = w.replace(/e$/, "");
    const groups = trimmed.match(/[aeiouy]+/g);
    const count = groups ? groups.length : 0;
    total += count > 0 ? count : 1;
  }
  return total;
}

/** Haiku shape: 3 non-empty lines, syllable counts close to (5,7,5). */
export function checkHaiku(response: string): LayerResult {
  const lines = response
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length !== 3) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.9,
      reason: `expected 3 lines, got ${lines.length}`,
      evidence: { lineCount: lines.length },
    };
  }
  const counts = lines.map(countSyllables);
  const target = [5, 7, 5];
  const within = counts.every((c, i) => Math.abs(c - (target[i] ?? 0)) <= 1);
  if (within) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.85,
      reason: `haiku shape OK: ${counts.join("-")} (±1)`,
      evidence: { counts },
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.8,
    reason: `haiku shape off: ${counts.join("-")} vs 5-7-5`,
    evidence: { counts },
  };
}

/** Tokenize for terse / brevity checks. */
function tokenize(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Filler phrases that violate the `terse` style directive. These are the
 * assistant-side pleasantry padding tokens that add length without substance.
 */
const TERSE_FILLER_PHRASES = [
  /\bcertainly\b/i,
  /\bof course\b/i,
  /\bgreat question\b/i,
  /\babsolutely\b/i,
  /\bi'?d be happy to\b/i,
  /\bi would be happy to\b/i,
];

/**
 * Hard character cap for the `terse` style (~50 tokens ≈ 280 chars).
 * Responses over this limit are clearly not terse regardless of token count.
 */
const TERSE_MAX_CHARS = 280;

/** Terseness: at most `maxTokens` whitespace tokens, ≤ 280 chars, and no filler phrases. */
export function checkTerse(response: string, maxTokens: number): LayerResult {
  const trimmed = response.trim();

  // Hard character cap first — cheapest check.
  if (trimmed.length > TERSE_MAX_CHARS) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.9,
      reason: `not terse: ${trimmed.length} chars > ${TERSE_MAX_CHARS} char cap`,
      evidence: { chars: trimmed.length, charCap: TERSE_MAX_CHARS },
    };
  }

  // Filler-phrase check.
  for (const re of TERSE_FILLER_PHRASES) {
    if (re.test(trimmed)) {
      return {
        layer: "phrase",
        verdict: "FAIL",
        confidence: 0.9,
        reason: `not terse: filler phrase matched: ${re}`,
        evidence: { matched: String(re) },
      };
    }
  }

  const tokens = tokenize(trimmed);
  if (tokens.length <= maxTokens) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.9,
      reason: `terse: ${tokens.length} ≤ ${maxTokens} tokens`,
      evidence: { tokens: tokens.length, max: maxTokens },
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.9,
    reason: `not terse: ${tokens.length} > ${maxTokens} tokens`,
    evidence: { tokens: tokens.length, max: maxTokens },
  };
}

/** "No emojis" trait check. */
export function checkNoEmojis(response: string): LayerResult {
  const count = countEmojis(response);
  if (count === 0) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 1.0,
      reason: "no emojis present",
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 1.0,
    reason: `${count} emoji(s) present`,
    evidence: { emojis: count },
  };
}

/** Forbidden-phrase trait check (case-insensitive substring). */
export function checkForbiddenPhrases(
  response: string,
  phrases: ReadonlyArray<string>,
): LayerResult {
  const lower = response.toLowerCase();
  const hits = phrases.filter((p) => lower.includes(p.toLowerCase()));
  if (hits.length === 0) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 1.0,
      reason: "no forbidden phrases used",
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 1.0,
    reason: `forbidden phrase(s) used: ${hits.join(", ")}`,
    evidence: { hits },
  };
}

/** Required pattern trait check (e.g. "respond in code blocks"). */
export function checkRequiredCodeBlock(response: string): LayerResult {
  if (hasCodeBlock(response)) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 1.0,
      reason: "code block present",
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 1.0,
    reason: "code block missing",
  };
}

/** Pirate-style hold check. */
export function checkPirate(response: string): LayerResult {
  const hits = PIRATE_TOKENS.filter((re) => re.test(response));
  if (hits.length >= 2) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.85,
      reason: `pirate tokens: ${hits.length}`,
      evidence: { hits: hits.map(String) },
    };
  }
  if (hits.length === 1) {
    return {
      layer: "phrase",
      verdict: "NEEDS_REVIEW",
      confidence: 0.5,
      reason: "only one pirate token — ambiguous",
      evidence: { hits: hits.map(String) },
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.85,
    reason: "no pirate tokens",
  };
}

/** Numeric warmth score used by the escalation rubric. Larger = warmer. */
export function warmthScore(response: string): number {
  let score = 0;
  for (const re of WARMTH_TOKENS) {
    if (re.test(response)) score += 1;
  }
  const emojis = countEmojis(response);
  score += emojis * 0.5;
  const excls = (response.match(/!/g) ?? []).length;
  score += Math.min(excls, 4) * 0.25;
  return score;
}

/**
 * Playfulness markers — distinct from warmth ("please/thank you"). Playful
 * responses carry levity: emojis, exclamation, parenthetical asides,
 * wordplay/puns, onomatopoeia, hedged-jokey phrases, and lighthearted
 * interjections.
 */
const PLAYFUL_TOKENS = [
  /\bhah?a+\b/i,
  /\bhehe?\b/i,
  /\blol\b/i,
  /\boops\b/i,
  /\byikes\b/i,
  /\bwoo+t?\b/i,
  /\bvoil[aà]\b/i,
  /\bta-?da\b/i,
  /\btada\b/i,
  /\bboom\b/i,
  /\bzap\b/i,
  /\bspoiler\b/i,
  /\bpun intended\b/i,
  /\bno pun intended\b/i,
  /\bbtw\b/i,
  /\bfun fact\b/i,
  /\bpro tip\b/i,
];

/**
 * Numeric playfulness score used by the escalation rubric for the `playful`
 * direction. Emojis, exclamations, parenthetical asides, and lighthearted
 * tokens count toward the score. Distinct from `warmthScore` which captures
 * politeness markers ("please/thank you") that do not necessarily move in
 * lockstep with playfulness.
 */
export function playfulScore(response: string): number {
  let score = 0;
  for (const re of PLAYFUL_TOKENS) {
    if (re.test(response)) score += 1;
  }
  const emojis = countEmojis(response);
  score += emojis * 0.75;
  const excls = (response.match(/!/g) ?? []).length;
  score += Math.min(excls, 6) * 0.5;
  // Parenthetical asides — a hallmark of conversational playfulness.
  const parentheticals = (response.match(/\([^)]{1,80}\)/g) ?? []).length;
  score += Math.min(parentheticals, 4) * 0.25;
  // En/em dashes used for jokey asides.
  const dashAsides = (response.match(/—[^—\n]{1,80}—|– [^–\n]{1,80} –/g) ?? [])
    .length;
  score += Math.min(dashAsides, 2) * 0.25;
  return score;
}

/** Token count helper exposed for tests. */
export function tokenCount(text: string): number {
  return tokenize(text).length;
}

/* ----------------------------------------------------------------------------
 * Trait rubrics: first_name_only / metric_units / prefers_short
 * -------------------------------------------------------------------------- */

/**
 * Honorifics that are forbidden under the `first_name_only` trait. We keep
 * the list tight on purpose — only formal address markers that a user
 * choosing "first-name only" would object to. Matching is word-boundary so
 * surnames containing one of these substrings (e.g. "Mister" inside a
 * sentence) don't false-positive.
 */
const HONORIFIC_TOKENS = [
  /\bmr\.?\b/i,
  /\bmrs\.?\b/i,
  /\bms\.?\b/i,
  /\bmiss\b/i,
  /\bmister\b/i,
  /\bmadam\b/i,
  /\bma'?am\b/i,
  /\bsir\b/i,
  /\bdr\.?\b/i,
  /\bdoctor\b/i,
  /\bprof\.?\b/i,
  /\bprofessor\b/i,
  /\blord\b/i,
  /\blady\b/i,
];

/**
 * Imperial units that should NOT appear under `metric_units`. The match is
 * word-boundary so we don't trip on "miles per gallon" inside a quoted
 * proverb that has been pre-cleared with a "not" / "converted from" lead-in
 * (see the wrapping check below).
 */
const IMPERIAL_TOKENS = [
  /\bmiles?\b/i,
  /\blbs?\b/i,
  /\bpounds?\b/i,
  /\bounces?\b/i,
  /\b°\s*f\b/i,
  /\bfahrenheit\b/i,
  /\binch(?:es)?\b/i,
  /\bfoot\b/i,
  /\bfeet\b/i,
  /\byards?\b/i,
  /\bgallons?\b/i,
  /\bquarts?\b/i,
];

/**
 * Metric markers — the presence of even one is enough to PASS the metric
 * check when no imperial markers were seen.
 */
const METRIC_TOKENS = [
  /\bkm\b/i,
  /\bkilometers?\b/i,
  /\bkilometres?\b/i,
  /\b\d+\s*m\b/i, // "5m" / "5 m" only — bare "m" letter alone is too noisy
  /\bmetres?\b/i,
  /\bmeters?\b/i,
  /\bcm\b/i,
  /\bcentimet(?:re|er)s?\b/i,
  /\bmm\b/i,
  /\bmillimet(?:re|er)s?\b/i,
  /\bkg\b/i,
  /\bkilograms?\b/i,
  /\bgrams?\b/i,
  /\b°\s*c\b/i,
  /\bcelsius\b/i,
  /\bliters?\b/i,
  /\blitres?\b/i,
];

/**
 * Negation markers preceding an imperial unit acknowledge it without
 * actually using imperial as the primary unit (e.g. "5 km — not 3 miles",
 * "10 kg, converted from 22 lbs"). Up to ~20 chars of preceding context.
 */
const IMPERIAL_NEGATION_PRE = [
  /\bnot\b\s+/i,
  /\bnever\b\s+/i,
  /\bconverted from\b\s+/i,
  /\binstead of\b\s+/i,
  /\brather than\b\s+/i,
  /\bequivalent to about\b\s+/i,
];

/**
 * `first_name_only` trait check.
 *
 * Fail if the response contains:
 *  - the user's surname (caller passes `lastName`), OR
 *  - any honorific token (mr./ms./sir/doctor/...).
 * Pass otherwise.
 */
export function checkFirstNameOnly(
  response: string,
  lastName: string | undefined,
): LayerResult {
  const trimmed = response.trim();
  if (trimmed.length === 0) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.9,
      reason: "empty response — no last name / honorific to flag",
    };
  }
  if (lastName && lastName.trim().length > 0) {
    const lnRegex = new RegExp(`\\b${escapeRegex(lastName.trim())}\\b`, "i");
    if (lnRegex.test(response)) {
      return {
        layer: "phrase",
        verdict: "FAIL",
        confidence: 0.95,
        reason: `last name "${lastName}" used despite first-name-only directive`,
        evidence: { lastName },
      };
    }
  }
  const hitHonorific = HONORIFIC_TOKENS.find((re) => re.test(response));
  if (hitHonorific) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.95,
      reason: `honorific used: ${hitHonorific}`,
      evidence: { matched: String(hitHonorific) },
    };
  }
  return {
    layer: "phrase",
    verdict: "PASS",
    confidence: 0.9,
    reason: "no last name or honorific in response",
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns true if every imperial-token match in `response` is preceded by a
 * recognised negation phrase (e.g. "not", "converted from"). We scan each
 * match's preceding ~30 chars.
 */
function imperialMatchesAllNegated(response: string): boolean {
  let foundAny = false;
  for (const re of IMPERIAL_TOKENS) {
    const global = new RegExp(
      re.source,
      re.flags.includes("g") ? re.flags : `${re.flags}g`,
    );
    let m: RegExpExecArray | null;
    while ((m = global.exec(response)) !== null) {
      foundAny = true;
      const start = Math.max(0, m.index - 30);
      const preceding = response.slice(start, m.index);
      const negated = IMPERIAL_NEGATION_PRE.some((preRe) =>
        preRe.test(preceding),
      );
      if (!negated) return false;
    }
  }
  return foundAny;
}

/**
 * `metric_units` trait check.
 *
 * Fail if response contains imperial units NOT preceded by a negation marker
 * ("not", "converted from", etc.). Pass if metric units are present OR no
 * units are mentioned at all.
 */
export function checkMetricUnits(response: string): LayerResult {
  const hitImperial = IMPERIAL_TOKENS.find((re) => re.test(response));
  const hitMetric = METRIC_TOKENS.find((re) => re.test(response));

  if (hitImperial) {
    if (imperialMatchesAllNegated(response)) {
      return {
        layer: "phrase",
        verdict: "PASS",
        confidence: 0.8,
        reason:
          "imperial mention(s) present but all are explicitly negated/converted",
        evidence: { matched: String(hitImperial) },
      };
    }
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.95,
      reason: `imperial unit used: ${hitImperial}`,
      evidence: { matched: String(hitImperial) },
    };
  }
  if (hitMetric) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.9,
      reason: `metric unit used: ${hitMetric}`,
      evidence: { matched: String(hitMetric) },
    };
  }
  return {
    layer: "phrase",
    verdict: "PASS",
    confidence: 0.85,
    reason: "no unit mentioned — vacuously metric-compliant",
  };
}

/**
 * `prefers_short` trait check.
 *
 *  - ≤ 80 tokens → PASS
 *  - 81–150 tokens → NEEDS_REVIEW (ambiguous: user said "short" but didn't
 *    pin a number; close to threshold)
 *  - > 150 tokens → FAIL (clearly not short).
 */
export function checkPrefersShort(
  response: string,
  options?: { passUpTo?: number; failOver?: number },
): LayerResult {
  const passUpTo = options?.passUpTo ?? 80;
  const failOver = options?.failOver ?? 150;
  const tokens = tokenize(response).length;
  if (tokens <= passUpTo) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.9,
      reason: `short: ${tokens} ≤ ${passUpTo} tokens`,
      evidence: { tokens, threshold: passUpTo },
    };
  }
  if (tokens > failOver) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.9,
      reason: `not short: ${tokens} > ${failOver} tokens`,
      evidence: { tokens, threshold: failOver },
    };
  }
  return {
    layer: "phrase",
    verdict: "NEEDS_REVIEW",
    confidence: 0.5,
    reason: `borderline length: ${tokens} tokens (between ${passUpTo} and ${failOver})`,
    evidence: { tokens },
  };
}

/* ----------------------------------------------------------------------------
 * Style rubrics: limerick / shakespearean / second_person_only
 * -------------------------------------------------------------------------- */

/**
 * Phonetic rhyme classes — orthographic endings that commonly produce the
 * same closing sound in English. We map each ending to a canonical key, then
 * compare keys. Coverage is far from complete; the goal is to catch the
 * common limerick rhyme patterns (long-vowel finishers, "-ash/-ish/-ock"
 * type couplets) without insisting on a phonetic library.
 */
const RHYME_CLASSES: ReadonlyArray<{ key: string; patterns: RegExp[] }> = [
  {
    key: "OO",
    patterns: [/ue$/, /ew$/, /oo$/, /ough$/, /ue[ds]?$/, /ews?$/, /oos?$/],
  },
  { key: "AY", patterns: [/ay$/, /ey$/, /ai[lnsd]?$/, /eigh$/, /a[mt]e$/] },
  { key: "AY-OPEN", patterns: [/aze$/, /ase$/, /ays?$/] },
  { key: "EE", patterns: [/ee$/, /ea$/, /y$/, /ie$/, /eed$/, /eaf$/] },
  { key: "OH", patterns: [/ow$/, /oe$/, /oa[dt]?$/, /ose$/, /old$/] },
  {
    key: "IGH",
    patterns: [/igh$/, /ight$/, /ie$/, /y$/, /ye$/, /ire$/, /ide$/],
  },
  { key: "ASH", patterns: [/ash$/, /ache$/, /ass$/] },
  { key: "ISH", patterns: [/ish$/, /itch$/] },
  { key: "OCK", patterns: [/ock$/, /ach$/, /awk$/, /alk$/] },
  { key: "EAR", patterns: [/ear$/, /eer$/, /ier$/, /ere$/] },
  { key: "AIR", patterns: [/air$/, /are$/, /ear$/] },
  { key: "ICE", patterns: [/ice$/, /ise$/, /yce$/] },
  { key: "AND", patterns: [/and$/, /anned$/] },
  { key: "AT", patterns: [/at$/, /att$/] },
  { key: "ER", patterns: [/er$/, /ur$/, /ir$/, /or$/] },
];

/**
 * Pull the rhyme key for the last word of a line. Strips punctuation, then
 * applies the orthographic-class lookup. Falls back to the last vowel-group
 * + trailing consonants when no class matches.
 */
function rhymeKey(line: string): string {
  const cleaned = line
    .replace(/[^a-z'\s]/gi, "")
    .trim()
    .toLowerCase();
  if (cleaned.length === 0) return "";
  const words = cleaned.split(/\s+/);
  const last = words[words.length - 1] ?? "";
  if (last.length === 0) return "";
  for (const cls of RHYME_CLASSES) {
    for (const re of cls.patterns) {
      if (re.test(last)) return cls.key;
    }
  }
  // Fallback: last vowel group + trailing consonants.
  const match = last.match(/[aeiouy]+[^aeiouy]*$/i);
  if (!match) return `tail:${last.slice(-2)}`;
  return `tail:${match[0]}`;
}

function rhymesWith(a: string, b: string): boolean {
  const ka = rhymeKey(a);
  const kb = rhymeKey(b);
  if (ka.length === 0 || kb.length === 0) return false;
  if (ka === kb) return true;
  // Fallback tail match: identical last 2 chars (handles same-word repeats
  // and exact orthographic rhymes the class table missed).
  const tailA = ka.startsWith("tail:") ? ka.slice(5) : "";
  const tailB = kb.startsWith("tail:") ? kb.slice(5) : "";
  if (tailA.length >= 2 && tailA === tailB) return true;
  return false;
}

/**
 * Limerick shape check: 5 non-empty lines, AABBA rhyme pattern.
 *
 * We don't enforce strict syllable counts — that's too noisy for a small
 * model. Rhyme key match is enough to separate genuine limericks from prose.
 */
export function checkLimerick(response: string): LayerResult {
  const lines = response
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length !== 5) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.9,
      reason: `expected 5 lines, got ${lines.length}`,
      evidence: { lineCount: lines.length },
    };
  }
  const aabba =
    rhymesWith(lines[0]!, lines[1]!) &&
    rhymesWith(lines[1]!, lines[4]!) &&
    rhymesWith(lines[2]!, lines[3]!) &&
    !rhymesWith(lines[0]!, lines[2]!); // A and B should differ
  if (aabba) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.8,
      reason: "limerick shape OK: 5 lines, AABBA rhyme",
      evidence: {
        rhymeKeys: lines.map(rhymeKey),
      },
    };
  }
  // Softer fallback: if all of A,A,A and B,B match but A=B, accept as
  // limerick-ish with NEEDS_REVIEW so the LLM can settle it.
  const aabbaWeak =
    rhymesWith(lines[0]!, lines[1]!) &&
    rhymesWith(lines[1]!, lines[4]!) &&
    rhymesWith(lines[2]!, lines[3]!);
  if (aabbaWeak) {
    return {
      layer: "phrase",
      verdict: "NEEDS_REVIEW",
      confidence: 0.55,
      reason: "rhyme pattern matches but A and B groups don't differ",
      evidence: { rhymeKeys: lines.map(rhymeKey) },
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.85,
    reason: "limerick rhyme pattern (AABBA) not satisfied",
    evidence: { rhymeKeys: lines.map(rhymeKey) },
  };
}

/** Early-modern English markers used by the `shakespearean` style check. */
const SHAKESPEAREAN_TOKENS = [
  /\bthee\b/i,
  /\bthou\b/i,
  /\bthy\b/i,
  /\bthine\b/i,
  /\bye\b/i,
  /\bart\b/i,
  /\bdoth\b/i,
  /\bdost\b/i,
  /\bhath\b/i,
  /\bhast\b/i,
  /\bshalt\b/i,
  /\bwilt\b/i,
  /\bprithee\b/i,
  /\bmethinks\b/i,
  /\bwherefore\b/i,
  /\bforsooth\b/i,
  /\bverily\b/i,
  /\bmayhap\b/i,
  /\bnay\b/i,
  /\baye\b/i,
  /\bo'er\b/i,
  /(^|\W)'tis\b/i,
  /(^|\W)'twas\b/i,
];

/**
 * Shakespearean / early-modern English style check.
 *
 *  - ≥ 3 archaic markers → PASS
 *  - 1–2 markers → NEEDS_REVIEW
 *  - 0 markers → FAIL
 *
 * Counts UNIQUE matches across distinct regexes so repeated "thou" still
 * counts as one. This stops a one-word ack ("thou.") from sweeping the bar.
 */
export function checkShakespearean(response: string): LayerResult {
  let hits = 0;
  const matched: string[] = [];
  for (const re of SHAKESPEAREAN_TOKENS) {
    if (re.test(response)) {
      hits += 1;
      matched.push(String(re));
    }
  }
  if (hits >= 3) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.85,
      reason: `early-modern markers: ${hits}`,
      evidence: { hits, matched },
    };
  }
  if (hits >= 1) {
    return {
      layer: "phrase",
      verdict: "NEEDS_REVIEW",
      confidence: 0.5,
      reason: `only ${hits} early-modern marker(s) — ambiguous`,
      evidence: { hits, matched },
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.85,
    reason: "no early-modern English markers",
  };
}

/**
 * First-person pronouns. NB: `\bI\b` is case-sensitive on purpose — lowercase
 * "i" inside words ("indian", "ill") would otherwise cause false positives.
 * Contractions like "I'm" / "I'll" are intentionally matched via the bare
 * `\bI\b` plus the dedicated apostrophe forms below (apostrophe is a non-word
 * char, so `\bI\b` already matches the leading "I"). To avoid double-counting
 * a single contraction, we use ONE bare `I` regex and only count distinct
 * pronouns through their tokens, accepting "I'm here" as a single hit
 * because the contracted forms are stripped before counting.
 */
const FIRST_PERSON_TOKENS: ReadonlyArray<RegExp> = [
  // Contractions first so they're stripped before the bare-I sweep.
  /\b(?:I'm|I've|I'll|I'd)\b/g,
  /\bme\b/gi,
  /\bmy\b/gi,
  /\bmine\b/gi,
  /\bwe\b/gi,
  /\bus\b/gi,
  /\bour\b/gi,
  /\bours\b/gi,
  /\bI\b/g, // case-sensitive bare-I; counted AFTER contractions are stripped.
];

const SECOND_PERSON_TOKENS = [
  /\byou\b/gi,
  /\byour\b/gi,
  /\byours\b/gi,
  /\byou're\b/gi,
  /\byou've\b/gi,
  /\byou'll\b/gi,
  /\byou'd\b/gi,
];

function countMatches(
  response: string,
  patterns: ReadonlyArray<RegExp>,
): number {
  let total = 0;
  let consumable = response;
  for (const re of patterns) {
    const matches = consumable.match(re);
    if (matches) {
      total += matches.length;
      // Strip matched substrings so later patterns don't double-count
      // (e.g. bare-I after I'm/I've contractions).
      consumable = consumable.replace(re, " ");
    }
  }
  return total;
}

/**
 * `second_person_only` style check.
 *
 *  - Fail if first-person count > 1 (allows the occasional "I" inside a
 *    quote or aside) OR if no second-person pronouns appear at all.
 *  - Pass if at least one "you/your" appears and first-person count ≤ 1.
 */
export function checkSecondPersonOnly(response: string): LayerResult {
  if (response.trim().length === 0) {
    return {
      layer: "phrase",
      verdict: "NEEDS_REVIEW",
      confidence: 0.4,
      reason: "empty response — can't verify second-person voice",
    };
  }
  const firstPerson = countMatches(response, FIRST_PERSON_TOKENS);
  const secondPerson = countMatches(response, SECOND_PERSON_TOKENS);

  if (firstPerson > 1) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.9,
      reason: `first-person pronouns used ${firstPerson}× (limit: ≤ 1)`,
      evidence: { firstPerson, secondPerson },
    };
  }
  if (secondPerson === 0) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.85,
      reason: "no second-person pronouns ('you', 'your') used",
      evidence: { firstPerson, secondPerson },
    };
  }
  return {
    layer: "phrase",
    verdict: "PASS",
    confidence: 0.85,
    reason: `second-person voice: you/your×${secondPerson}, first-person×${firstPerson}`,
    evidence: { firstPerson, secondPerson },
  };
}

/* ----------------------------------------------------------------------------
 * Precise pattern checks for no_exclamation / no_questions_back / no_lists
 * These replace the brittle single-character forbidden-phrase mappings
 * (W5-tra §7a) that caused false-positives when injection payloads or normal
 * punctuation contained the bare characters.
 * -------------------------------------------------------------------------- */

/**
 * Strip content between triple-backtick fences and bare URLs so injection
 * payloads embedded in code blocks don't trigger prose-level checks.
 */
function stripNoisyContent(text: string): string {
  // Remove fenced code blocks.
  let cleaned = text.replace(/```[\s\S]*?```/g, " ");
  // Remove inline code spans.
  cleaned = cleaned.replace(/`[^`]*`/g, " ");
  // Remove URLs (http/https/ftp).
  cleaned = cleaned.replace(/https?:\/\/\S+|ftp:\/\/\S+/g, " ");
  return cleaned;
}

/**
 * `no_exclamation` trait check.
 *
 * Fails only when the agent's own prose contains `!` used as a sentence
 * terminator (preceded by a word character). Strips fenced code blocks and
 * URLs before scanning so injection payloads and technical content don't
 * false-positive.
 */
export function checkNoExclamation(response: string): LayerResult {
  const prose = stripNoisyContent(response);
  // Match `!` preceded by a word char — sentence-terminator pattern.
  const hits = prose.match(/\w!/g) ?? [];
  if (hits.length === 0) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.95,
      reason: "no exclamation marks used as sentence terminators",
    };
  }
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.95,
    reason: `exclamation mark(s) used as sentence terminator: ${hits.length}`,
    evidence: { count: hits.length },
  };
}

/**
 * `no_questions_back` trait check.
 *
 * Fails only when the agent's own text (after stripping injection payloads
 * between triple-backtick or IGNORE_BELOW markers) contains a `?`.
 */
export function checkNoQuestionsBack(response: string): LayerResult {
  // Strip injection payload markers — text after IGNORE_BELOW is adversarial.
  const withoutInjection = response
    .replace(/IGNORE_BELOW[\s\S]*/i, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ");
  if (withoutInjection.includes("?")) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.95,
      reason: "agent response contains a question mark",
    };
  }
  return {
    layer: "phrase",
    verdict: "PASS",
    confidence: 0.95,
    reason: "no question marks in agent response",
  };
}

/**
 * `no_lists` trait check.
 *
 * Fails only when the response contains ≥ 2 consecutive lines that start
 * with a list marker (`- `, `* `, `1.`, `1)`) at the beginning of the line.
 * Isolated list-marker-like text inside sentences does not count.
 */
export function checkNoLists(response: string): LayerResult {
  const lines = response.split(/\r?\n/);
  // A line "starts a list" if it begins (after optional whitespace) with a
  // bullet or numbered list prefix.
  const LIST_LINE = /^\s*(?:[-*][ \t]|\d+[.)]\s)/;
  let consecutiveListLines = 0;
  let maxConsecutive = 0;
  for (const line of lines) {
    if (LIST_LINE.test(line)) {
      consecutiveListLines += 1;
      if (consecutiveListLines > maxConsecutive)
        maxConsecutive = consecutiveListLines;
    } else {
      consecutiveListLines = 0;
    }
  }
  if (maxConsecutive >= 2) {
    return {
      layer: "phrase",
      verdict: "FAIL",
      confidence: 0.95,
      reason: `list detected: ${maxConsecutive} consecutive list-style lines`,
      evidence: { maxConsecutive },
    };
  }
  return {
    layer: "phrase",
    verdict: "PASS",
    confidence: 0.9,
    reason: "no multi-line list structure found",
    evidence: { maxConsecutive },
  };
}

/**
 * The all-lowercase check. Used by the `hold_style.*.all_lowercase.*` slice.
 *
 * The user directive is "type everything in lowercase from now on — no capital
 * letters". We strip fenced code blocks (their casing is dictated by the
 * language, not by the prose-style directive), then count uppercase letters in
 * the remaining prose. Standalone acronyms inside the prose still count as
 * violations because the directive is explicit ("no capital letters").
 *
 * A small tolerance — one uppercase letter — covers the rare model artefact
 * of a stray cap at the start of a numbered point ("1. The …"). Anything more
 * than that is a failure.
 */
export function checkAllLowercase(response: string): LayerResult {
  const trimmed = response.trim();
  if (trimmed.length === 0) {
    return {
      layer: "phrase",
      verdict: "NEEDS_REVIEW",
      confidence: 0.4,
      reason: "empty response — can't verify lowercase style",
    };
  }
  // Strip fenced code blocks — their casing is language-dictated, not prose.
  const prose = trimmed.replace(/```[\s\S]*?```/g, "");
  // Also strip inline code spans for the same reason.
  const proseNoInline = prose.replace(/`[^`]*`/g, "");
  const uppercaseMatches = proseNoInline.match(/[A-Z]/g) ?? [];
  const upper = uppercaseMatches.length;
  // Tolerate at most one stray uppercase letter (typical "1. The ..." artefact).
  const MAX_TOLERATED = 1;
  if (upper <= MAX_TOLERATED) {
    return {
      layer: "phrase",
      verdict: "PASS",
      confidence: 0.95,
      reason:
        upper === 0
          ? "all-lowercase prose (no uppercase letters)"
          : `${upper} uppercase letter (within tolerance ${MAX_TOLERATED})`,
      evidence: { uppercase: upper },
    };
  }
  // Sample up to 5 of the offending letters so failure logs stay useful.
  const sample = uppercaseMatches.slice(0, 5).join("");
  return {
    layer: "phrase",
    verdict: "FAIL",
    confidence: 0.95,
    reason: `${upper} uppercase letter(s) in prose (e.g. "${sample}") — directive was all-lowercase`,
    evidence: { uppercase: upper, sample },
  };
}
