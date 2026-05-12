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

export const EMOTIONS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "fearful",
  "disgusted",
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export const DEFAULT_EMOTION: Emotion = "neutral";

const EMOTION_SYNONYMS: Record<string, Emotion> = {
  neutral: "neutral",
  calm: "neutral",
  flat: "neutral",
  happy: "happy",
  joyful: "happy",
  excited: "happy",
  glad: "happy",
  cheerful: "happy",
  sad: "sad",
  sorrowful: "sad",
  unhappy: "sad",
  melancholy: "sad",
  angry: "angry",
  mad: "angry",
  furious: "angry",
  irritated: "angry",
  surprised: "surprised",
  shocked: "surprised",
  amazed: "surprised",
  fearful: "fearful",
  scared: "fearful",
  afraid: "fearful",
  worried: "fearful",
  anxious: "fearful",
  disgusted: "disgusted",
  revolted: "disgusted",
  grossed: "disgusted",
};

function isEmotion(value: string): value is Emotion {
  return (EMOTIONS as readonly string[]).includes(value);
}

/**
 * Coerce arbitrary input into a known emotion. Falls back to
 * `DEFAULT_EMOTION` rather than throwing — emotion is a hint, not a
 * load-bearing field. Accepts canonical names, synonyms, and casing
 * variants; rejects everything else.
 */
export function coerceEmotion(input: unknown): Emotion {
  if (typeof input !== "string") return DEFAULT_EMOTION;
  const lower = input.trim().toLowerCase();
  if (lower.length === 0) return DEFAULT_EMOTION;
  if (isEmotion(lower)) return lower;
  const synonym = EMOTION_SYNONYMS[lower];
  return synonym ?? DEFAULT_EMOTION;
}

const KEYWORD_RULES: Array<[Emotion, RegExp]> = [
  [
    "happy",
    /\b(yay|hooray|love|great|awesome|amazing|nice|haha|lol|😊|😄|🥰|❤️|🎉)\b/iu,
  ],
  [
    "sad",
    /\b(sorry|sad|miss|lonely|alone|cry|tears|hurt|disappointed|😢|😭|💔)\b/iu,
  ],
  ["angry", /\b(angry|mad|furious|hate|stupid|damn|wtf|😠|😡|🤬)\b/iu],
  [
    "surprised",
    /\b(wow|whoa|really|seriously|no way|omg|oh my|incredible|😲|😮)\b/iu,
  ],
  ["fearful", /\b(scared|afraid|worried|anxious|nervous|terrified|😨|😰)\b/iu],
  ["disgusted", /\b(gross|ew|yuck|disgusting|nasty|🤢|🤮)\b/iu],
];

/**
 * Heuristic emotion classifier from raw text. Cheap regex-based
 * scoring suitable for inline use during TTS dispatch. Returns
 * `DEFAULT_EMOTION` when no rule fires.
 *
 * Replace with a model-backed classifier when one becomes available
 * in-process (e.g. emotion2vec text head). Until then, this is good
 * enough to drive omnivoice voice-design hints from assistant output.
 */
export function emotionFromText(text: string): Emotion {
  if (typeof text !== "string" || text.trim().length === 0) {
    return DEFAULT_EMOTION;
  }
  const counts = new Map<Emotion, number>();
  for (const [emotion, pattern] of KEYWORD_RULES) {
    const matches = text.match(pattern);
    if (matches)
      counts.set(emotion, (counts.get(emotion) ?? 0) + matches.length);
  }
  let best: Emotion = DEFAULT_EMOTION;
  let bestCount = 0;
  for (const [emotion, count] of counts) {
    if (count > bestCount) {
      best = emotion;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Render an emotion as the keyword omnivoice's voice-design grammar
 * understands. Returns `undefined` for `neutral` so callers can skip
 * appending the keyword to the instruct string.
 */
export function emotionToOmnivoiceKeyword(
  emotion: Emotion,
): string | undefined {
  if (emotion === "neutral") return undefined;
  return emotion;
}
