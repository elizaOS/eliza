/**
 * Playback / TTS logic for voice chat — text processing, sentence splitting,
 * speech text extraction, and mouth animation helpers.
 */

import { sanitizeSpeechText } from "@elizaos/shared";
import {
  MAX_SPOKEN_CHARS,
  MOUTH_OPEN_STEP,
  SHORT_AUDIO_CACHE_MAX_TOKENS,
  type SpeechSegmentKind,
} from "./voice-chat-types";

// ── Text processing helpers ───────────────────────────────────────────

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function normalizeCacheText(input: string): string {
  return collapseWhitespace(input.normalize("NFKC")).toLowerCase();
}

export function countSpeechTokens(input: string): number {
  const normalized = collapseWhitespace(input);
  return normalized ? normalized.split(/\s+/).length : 0;
}

export function shouldCacheGeneratedSpeech(
  input: string,
  segment: SpeechSegmentKind,
): boolean {
  return (
    segment !== "remainder" &&
    countSpeechTokens(input) <= SHORT_AUDIO_CACHE_MAX_TOKENS
  );
}

export function capSpeechLength(input: string): string {
  if (input.length <= MAX_SPOKEN_CHARS) return input;
  const clipped = input.slice(0, MAX_SPOKEN_CHARS);
  const splitAt = clipped.lastIndexOf(" ");
  const body = splitAt > 120 ? clipped.slice(0, splitAt) : clipped;
  return `${body.trim()}...`;
}

// ── Hidden model block stripping ──────────────────────────────────────

/**
 * Hidden model block tags whose content should never be spoken. During
 * streaming the closing tag may not have arrived yet, so we strip from
 * the opening tag to end-of-string.
 *
 * The upstream `sanitizeSpeechText` only strips *closed* `<think>` blocks,
 * so an in-progress `<think>reasoning so far` leaks "reasoning so far"
 * into the voice output.  We handle it here before sanitization.
 */
const HIDDEN_VOICE_BLOCK_RE =
  /<(think|thought|analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

function parseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractStructuredVoiceText(input: string): string | null {
  const parsed = parseJsonObject(input);
  if (!parsed) return null;

  if (typeof parsed.text === "string") {
    return parsed.text;
  }

  if ("actions" in parsed || "params" in parsed || "providers" in parsed) {
    return "";
  }

  return null;
}

export function extractVoiceText(input: string): string {
  let text = extractStructuredVoiceText(input) ?? input;

  text = text.replace(HIDDEN_VOICE_BLOCK_RE, " ");
  text = text.replace(/<\/?[a-zA-Z][^>]*$|<\/?$/s, "");

  return text;
}

export function toSpeakableText(input: string): string {
  const extracted = extractVoiceText(input);
  if (!extracted) return "";
  const normalized = sanitizeSpeechText(extracted);
  if (!normalized) return "";
  return capSpeechLength(normalized);
}

// ── Sentence splitting ────────────────────────────────────────────────

/** Common abbreviations that end with a period but are not sentence endings. */
const ABBREV_RE =
  /(?:Mr|Mrs|Ms|Dr|Jr|Sr|St|vs|etc|approx|Prof|Rev|Gen|Sgt|Lt|Col|Maj|Capt|Corp|Pvt|Ave|Blvd|dept|est|govt|assn)$/;

/**
 * Replace URLs with placeholders so their internal dots are not treated as
 * sentence boundaries.  Returns the cleaned string and a restore function.
 */
export function shelterUrls(input: string): {
  text: string;
  restore: (s: string) => string;
} {
  const urls: string[] = [];
  const text = input.replace(/https?:\/\/\S+/g, (m) => {
    urls.push(m);
    return `__URL${urls.length - 1}__`;
  });
  return {
    text,
    restore: (s: string) =>
      s.replace(/__URL(\d+)__/g, (_, i) => urls[Number(i)] ?? _),
  };
}

/**
 * Test whether a period match at `index` inside `value` is a real sentence
 * boundary (not an abbreviation or decimal).
 */
export function isRealSentenceEnd(value: string, matchIndex: number): boolean {
  const previousChar = matchIndex > 0 ? value[matchIndex - 1] : undefined;
  const nextChar =
    matchIndex + 1 < value.length ? value[matchIndex + 1] : undefined;

  if (previousChar !== undefined && /\d/.test(previousChar)) {
    if (nextChar !== undefined && /\d/.test(nextChar)) {
      return false;
    }
  }
  const before = value.slice(0, matchIndex);
  if (ABBREV_RE.test(before)) return false;
  return true;
}

export function splitFirstSentence(text: string): {
  complete: boolean;
  firstSentence: string;
  remainder: string;
} {
  const value = collapseWhitespace(text);
  if (!value) return { complete: false, firstSentence: "", remainder: "" };

  const { text: sheltered, restore } = shelterUrls(value);

  const boundary = /([.!?]+(?:["')\]]+)?)(?:\s|$)/g;
  let match: RegExpExecArray | null = null;
  while (true) {
    match = boundary.exec(sheltered);
    if (!match || typeof match.index !== "number") break;

    const punctChar = match[1]?.[0];

    if (punctChar === ".") {
      if (match[1]?.length >= 3) continue;
      if (!isRealSentenceEnd(sheltered, match.index)) continue;
    }

    const endIndex = match.index + match[0].length;
    const firstSentence = restore(sheltered.slice(0, endIndex).trim());
    const remainder = restore(sheltered.slice(endIndex).trim());
    if (firstSentence.length > 0) {
      return { complete: true, firstSentence, remainder };
    }
  }

  if (value.length >= 180) {
    const window = value.slice(0, 180);
    const splitAt = window.lastIndexOf(" ");
    if (splitAt > 100) {
      return {
        complete: true,
        firstSentence: window.slice(0, splitAt).trim(),
        remainder: value.slice(splitAt).trim(),
      };
    }
  }

  return { complete: false, firstSentence: value, remainder: "" };
}

export function remainderAfter(
  fullText: string,
  firstSentence: string,
): string {
  const full = collapseWhitespace(fullText);
  const first = collapseWhitespace(firstSentence);
  if (!full || !first) return full;
  if (full.startsWith(first)) return full.slice(first.length).trim();

  const lowerFull = full.toLowerCase();
  const lowerFirst = first.toLowerCase();
  if (lowerFull.startsWith(lowerFirst)) {
    return full.slice(first.length).trim();
  }

  const idx = lowerFull.indexOf(lowerFirst);
  if (idx >= 0) {
    return full.slice(idx + first.length).trim();
  }

  return "";
}

export function queueableSpeechPrefix(text: string, isFinal: boolean): string {
  const value = collapseWhitespace(text);
  if (!value) return "";
  if (isFinal) return value;

  const { text: sheltered, restore } = shelterUrls(value);

  let lastSentenceEnd = 0;
  const boundary = /([.!?]+(?:["')\]]+)?)(?:\s|$)/g;
  let match: RegExpExecArray | null = null;
  while (true) {
    match = boundary.exec(sheltered);
    if (!match || typeof match.index !== "number") break;

    const punctChar = match[1]?.[0];
    if (punctChar === ".") {
      if (match[1]?.length >= 3) continue;
      if (!isRealSentenceEnd(sheltered, match.index)) continue;
    }

    lastSentenceEnd = match.index + match[0].length;
  }
  if (lastSentenceEnd > 0) {
    return restore(sheltered.slice(0, lastSentenceEnd).trim());
  }

  if (value.length >= 180) {
    const window = value.slice(0, 180);
    const splitAt = window.lastIndexOf(" ");
    if (splitAt > 100) {
      return window.slice(0, splitAt).trim();
    }
  }
  return "";
}

// ── Mouth animation ───────────────────────────────────────────────────

export function normalizeMouthOpen(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  const stepped = Math.round(clamped / MOUTH_OPEN_STEP) * MOUTH_OPEN_STEP;
  return stepped < MOUTH_OPEN_STEP ? 0 : Math.min(1, stepped);
}

export function nextIdleMouthOpen(currentValue: number): number {
  const current = normalizeMouthOpen(currentValue);
  if (current <= MOUTH_OPEN_STEP) {
    return 0;
  }
  return Math.max(0, Math.min(current * 0.85, current - MOUTH_OPEN_STEP));
}
