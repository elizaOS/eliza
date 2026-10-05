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
