/**
 * Local mirror of the emotion taxonomy from
 * `packages/ui/src/voice/emotion.ts`. The plugin can't import from
 * @elizaos/ui directly (it's a presentation-layer package and would
 * pull DOM types). The shape is intentionally identical so a future
 * shared package can replace both.
 *
 * NB: this file is small on purpose. If it grows beyond a re-export of
 * the canonical taxonomy, lift it into a shared `@elizaos/voice` core
 * package instead of letting a second copy diverge.
 */

import type { Emotion } from "./types";

const EMOTION_SET: ReadonlySet<Emotion> = new Set([
  "neutral",
  "happy",
  "sad",
  "angry",
  "surprised",
  "fearful",
  "disgusted",
]);

const SYNONYMS: Record<string, Emotion> = {
  calm: "neutral",
  flat: "neutral",
  joyful: "happy",
  excited: "happy",
  glad: "happy",
  cheerful: "happy",
  sorrowful: "sad",
  unhappy: "sad",
  melancholy: "sad",
  mad: "angry",
  furious: "angry",
  irritated: "angry",
  shocked: "surprised",
  amazed: "surprised",
  scared: "fearful",
  afraid: "fearful",
  worried: "fearful",
  anxious: "fearful",
  revolted: "disgusted",
  grossed: "disgusted",
};

export const DEFAULT_EMOTION: Emotion = "neutral";

export function coerceEmotion(input: unknown): Emotion {
  if (typeof input !== "string") return DEFAULT_EMOTION;
  const lower = input.trim().toLowerCase();
  if (lower.length === 0) return DEFAULT_EMOTION;
  if (EMOTION_SET.has(lower as Emotion)) return lower as Emotion;
  return SYNONYMS[lower] ?? DEFAULT_EMOTION;
}

export function emotionToOmnivoiceKeyword(
  emotion: Emotion,
): string | undefined {
  return emotion === "neutral" ? undefined : emotion;
}
