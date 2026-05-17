/**
 * Emotion taxonomy for voice synthesis. Shared by the UI hooks
 * (useVoiceChat) and TTS plugins (omnivoice voice-design instruct,
 * elevenlabs `voice_settings.style`, …).
 *
 * The taxonomy intentionally mirrors the seven Ekman basic emotions
 * (extended with `neutral`) — every modern emotion-aware TTS / ASR
 * model in 2026 maps cleanly onto this set:
 *   - omnivoice voice-design `emotion` keyword
 *   - SenseVoice ASR emotion tags
 *   - emotion2vec / emotion2vec_plus class indices
 *   - OpenVoice v2 reference WAV bins
 *
 * Keep this list strict. Adding entries forces every consumer to
 * re-evaluate its mapping table — not a free change.
 */
export declare const EMOTIONS: readonly [
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "fearful",
  "disgusted",
];
export type Emotion = (typeof EMOTIONS)[number];
export declare const DEFAULT_EMOTION: Emotion;
/**
 * Coerce arbitrary input into a known emotion. Falls back to
 * `DEFAULT_EMOTION` rather than throwing — emotion is a hint, not a
 * load-bearing field. Accepts canonical names, synonyms, and casing
 * variants; rejects everything else.
 */
export declare function coerceEmotion(input: unknown): Emotion;
/**
 * Heuristic emotion classifier from raw text. Cheap regex-based
 * scoring suitable for inline use during TTS dispatch. Returns
 * `DEFAULT_EMOTION` when no rule fires.
 *
 * Replace with a model-backed classifier when one becomes available
 * in-process (e.g. emotion2vec text head). Until then, this is good
 * enough to drive omnivoice voice-design hints from assistant output.
 */
export declare function emotionFromText(text: string): Emotion;
/**
 * Render an emotion as the keyword omnivoice's voice-design grammar
 * understands. Returns `undefined` for `neutral` so callers can skip
 * appending the keyword to the instruct string.
 */
export declare function emotionToOmnivoiceKeyword(
  emotion: Emotion,
): string | undefined;
//# sourceMappingURL=emotion.d.ts.map
