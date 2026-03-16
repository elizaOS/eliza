/**
 * Pricing and configuration constants
 * This file contains only constants with no server-side dependencies,
 * making it safe to import from client components.
 */

/**
 * API key prefix length for display purposes.
 */
export const API_KEY_PREFIX_LENGTH = 12;

/**
 * Platform markup multiplier.
 * Applied to all AI inference and service costs.
 * 1.2 = 20% markup on top of provider costs.
 */
export const PLATFORM_MARKUP_MULTIPLIER = 1.2;

/**
 * Service costs in USD (stored as decimal values).
 * These are actual dollar amounts that will be deducted from credit_balance.
 * All costs include the 20% platform markup.
 */
// Base provider costs (before markup)
const BASE_IMAGE_GENERATION_COST = 0.0083; // ~$0.0083 per image from provider
const BASE_VIDEO_GENERATION_COST = 0.0417; // ~$0.0417 per video from provider
const BASE_VIDEO_GENERATION_FALLBACK_COST = 0.0208; // ~$0.0208 per fallback video

// Final costs with 20% platform markup
export const IMAGE_GENERATION_COST =
  Math.round(BASE_IMAGE_GENERATION_COST * PLATFORM_MARKUP_MULTIPLIER * 100) /
  100; // $0.01 per image
export const VIDEO_GENERATION_COST =
  Math.round(BASE_VIDEO_GENERATION_COST * PLATFORM_MARKUP_MULTIPLIER * 100) /
  100; // $0.05 per video
export const VIDEO_GENERATION_FALLBACK_COST =
  Math.round(
    BASE_VIDEO_GENERATION_FALLBACK_COST * PLATFORM_MARKUP_MULTIPLIER * 1000,
  ) / 1000; // $0.025 per fallback video

/**
 * Monthly credit cap in USD.
 */
export const MONTHLY_CREDIT_CAP = 2.4;

/**
 * Voice cloning costs in USD (with 20% platform markup).
 */
const BASE_VOICE_CLONE_INSTANT_COST = 0.42; // Base cost ~$0.42
const BASE_VOICE_CLONE_PROFESSIONAL_COST = 1.67; // Base cost ~$1.67
const BASE_VOICE_SAMPLE_UPLOAD_COST = 0.042; // Base cost ~$0.042
const BASE_VOICE_UPDATE_COST = 0.083; // Base cost ~$0.083

export const VOICE_CLONE_INSTANT_COST =
  Math.round(BASE_VOICE_CLONE_INSTANT_COST * PLATFORM_MARKUP_MULTIPLIER * 100) /
  100; // ~$0.50 - 1-3 min audio, ~30s processing
export const VOICE_CLONE_PROFESSIONAL_COST =
  Math.round(
    BASE_VOICE_CLONE_PROFESSIONAL_COST * PLATFORM_MARKUP_MULTIPLIER * 100,
  ) / 100; // ~$2.00 - 30+ min audio, 30-60min processing
export const VOICE_SAMPLE_UPLOAD_COST =
  Math.round(BASE_VOICE_SAMPLE_UPLOAD_COST * PLATFORM_MARKUP_MULTIPLIER * 100) /
  100; // ~$0.05 - Additional samples to existing voice
export const VOICE_UPDATE_COST =
  Math.round(BASE_VOICE_UPDATE_COST * PLATFORM_MARKUP_MULTIPLIER * 100) / 100; // ~$0.10 - Update voice metadata/settings
export const CUSTOM_VOICE_TTS_MARKUP = 1.1; // 10% additional markup for using custom cloned voices (on top of platform markup)

/**
 * TTS/STT costs in USD (with 20% platform markup).
 * Based on ElevenLabs pricing.
 */
const BASE_TTS_COST_PER_1K_CHARS = 0.024; // ElevenLabs ~$0.024 per 1K characters
const BASE_STT_COST_PER_MINUTE = 0.0033; // ElevenLabs ~$0.0033 per minute

export const TTS_COST_PER_1K_CHARS =
  Math.round(BASE_TTS_COST_PER_1K_CHARS * PLATFORM_MARKUP_MULTIPLIER * 10000) /
  10000; // ~$0.029 per 1K chars with markup
export const STT_COST_PER_MINUTE =
  Math.round(BASE_STT_COST_PER_MINUTE * PLATFORM_MARKUP_MULTIPLIER * 10000) /
  10000; // ~$0.004 per minute with markup
export const TTS_MINIMUM_COST = 0.001; // Minimum charge for any TTS request
export const STT_MINIMUM_COST = 0.001; // Minimum charge for any STT request
