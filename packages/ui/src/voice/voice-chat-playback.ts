import {
  collapseWhitespace,
  isRealSentenceEnd,
  shelterUrls,
} from "./speech-segments";

export {
  collapseWhitespace,
  isRealSentenceEnd,
  shelterUrls,
  splitFirstSentence,
} from "./speech-segments";

/**
 * Playback / TTS logic for voice chat — text processing, sentence splitting,
 * speech text extraction, and mouth animation helpers.
 */
import { ElizaError, sanitizeSpeechText } from "@elizaos/core/speech";
export type SpeechSegmentKind = "full" | "first-sentence" | "remainder";
export const MOUTH_OPEN_STEP = 0.02;
// ── Text processing helpers ───────────────────────────────────────────
export function normalizeCacheText(input: string): string {
  return collapseWhitespace(input.normalize("NFKC")).toLowerCase();
}

export function shouldCacheGeneratedSpeech(
  _input: string,
  segment: SpeechSegmentKind,
): boolean {
  return segment !== "remainder";
}
export function capSpeechLength(input: string): string {
  return input;
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
  /<(think|thought|analysis|reasoning|tool_calls?|tools?)(?=[\s/>])[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;
function parseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // error-policy:J3 "is this structured?" probe — non-JSON message text is
    // the normal case and speaks as plain text
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
/** Committed words may gain punctuation, but must never turn into a longer word. */
export function isCommittedSpeechPrefix(
  fullText: string,
  prefix: string,
): boolean {
  const full = collapseWhitespace(fullText);
  const committed = collapseWhitespace(prefix);
  return (
    !committed ||
    full === committed ||
    (full.startsWith(committed) &&
      /^[\s.,!?;:…]/u.test(full.slice(committed.length)))
  );
}
export function remainderAfter(
  fullText: string,
  firstSentence: string,
): string {
  const full = collapseWhitespace(fullText);
  const first = collapseWhitespace(firstSentence);
  if (!full || !first) return full;
  if (isCommittedSpeechPrefix(full, first))
    return full.slice(first.length).trim();
  throw new ElizaError(
    "The reply changed after speech was queued. Play the completed reply again.",
    {
      code: "VOICE_SPEECH_REVISION_UNSUPPORTED",
      context: {
        queuedCharacters: first.length,
        receivedCharacters: full.length,
      },
    },
  );
}
/** Keep the unfinished final lexical unit for a later frame or the final flush. */
export function stableSpeechPrefix(text: string): string {
  const value = collapseWhitespace(text);
  const boundary = value.lastIndexOf(" ");
  return boundary < 0 ? "" : value.slice(0, boundary);
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
