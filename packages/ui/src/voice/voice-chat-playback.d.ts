/**
 * Playback / TTS logic for voice chat — text processing, sentence splitting,
 * speech text extraction, and mouth animation helpers.
 */
import { type SpeechSegmentKind } from "./voice-chat-types";
export declare function collapseWhitespace(input: string): string;
export declare function normalizeCacheText(input: string): string;
export declare function countSpeechTokens(input: string): number;
export declare function shouldCacheGeneratedSpeech(
  input: string,
  segment: SpeechSegmentKind,
): boolean;
export declare function capSpeechLength(input: string): string;
export declare function extractVoiceText(input: string): string;
export declare function toSpeakableText(input: string): string;
/**
 * Replace URLs with placeholders so their internal dots are not treated as
 * sentence boundaries.  Returns the cleaned string and a restore function.
 */
export declare function shelterUrls(input: string): {
  text: string;
  restore: (s: string) => string;
};
/**
 * Test whether a period match at `index` inside `value` is a real sentence
 * boundary (not an abbreviation or decimal).
 */
export declare function isRealSentenceEnd(
  value: string,
  matchIndex: number,
): boolean;
export declare function splitFirstSentence(text: string): {
  complete: boolean;
  firstSentence: string;
  remainder: string;
};
export declare function remainderAfter(
  fullText: string,
  firstSentence: string,
): string;
export declare function queueableSpeechPrefix(
  text: string,
  isFinal: boolean,
): string;
export declare function normalizeMouthOpen(value: number): number;
export declare function nextIdleMouthOpen(currentValue: number): number;
//# sourceMappingURL=voice-chat-playback.d.ts.map
