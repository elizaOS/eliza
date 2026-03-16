/**
 * Shared constants for image generation across miniapp and main app
 */

export const IMAGE_GENERATION_VIBES = [
  "flirty",
  "shy",
  "bold",
  "spicy",
  "romantic",
  "playful",
  "mysterious",
  "intellectual",
] as const;

export type ImageGenerationVibe = (typeof IMAGE_GENERATION_VIBES)[number];

export const DEFAULT_VIBE: ImageGenerationVibe = "playful";

/**
 * Size limits for uploads
 */
export const MAX_AVATAR_SIZE_MB = 5;
export const MAX_AVATAR_SIZE_BYTES = MAX_AVATAR_SIZE_MB * 1024 * 1024;
export const MAX_IMAGE_SIZE_MB = 10;
export const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

/**
 * Prompt configuration limits
 */
export const MAX_PROMPT_LENGTH = 2000;
export const MAX_RESPONSE_STYLE_LENGTH = 1000;

/**
 * Rate limiting for auto-image generation
 */
export const MIN_IMAGE_INTERVAL_MS = 60 * 1000; // 1 minute between auto-generated images
