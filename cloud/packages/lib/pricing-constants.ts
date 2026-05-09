/**
 * Pricing and configuration constants
 * This file contains only constants with no server-side dependencies,
 * making it safe to import from client components.
 */

import { PLATFORM_MARKUP_MULTIPLIER } from "@elizaos/billing";

/**
 * API key prefix length for display purposes.
 */
export const API_KEY_PREFIX_LENGTH = 12;

export { PLATFORM_MARKUP_MULTIPLIER };

/**
 * Service costs in USD (stored as decimal values).
 * These are actual dollar amounts that will be deducted from credit_balance.
 * All costs include the 20% platform markup.
 */
// Base provider costs (before markup).
// These are fallback/display defaults only; live media billing uses the
// ai_pricing catalog where available.
export const BASE_IMAGE_GENERATION_COST = 0.039; // Gemini 2.5 Flash Image default output estimate
const BASE_VIDEO_GENERATION_COST = 3.2; // Veo 3/3.1 8s 1080p video with audio
const BASE_VIDEO_GENERATION_FALLBACK_COST = 0.28; // Lowest curated default video request

// Final costs with 20% platform markup
export const IMAGE_GENERATION_COST =
  Math.round(BASE_IMAGE_GENERATION_COST * PLATFORM_MARKUP_MULTIPLIER * 10000) / 10000; // $0.0468 per image
export const VIDEO_GENERATION_COST =
  Math.round(BASE_VIDEO_GENERATION_COST * PLATFORM_MARKUP_MULTIPLIER * 1000) / 1000; // $3.84 per default high-end video
export const VIDEO_GENERATION_FALLBACK_COST =
  Math.round(BASE_VIDEO_GENERATION_FALLBACK_COST * PLATFORM_MARKUP_MULTIPLIER * 1000) / 1000; // $0.336 per low-end video

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
  Math.round(BASE_VOICE_CLONE_INSTANT_COST * PLATFORM_MARKUP_MULTIPLIER * 100) / 100; // ~$0.50 - 1-3 min audio, ~30s processing
export const VOICE_CLONE_PROFESSIONAL_COST =
  Math.round(BASE_VOICE_CLONE_PROFESSIONAL_COST * PLATFORM_MARKUP_MULTIPLIER * 100) / 100; // ~$2.00 - 30+ min audio, 30-60min processing
export const VOICE_SAMPLE_UPLOAD_COST =
  Math.round(BASE_VOICE_SAMPLE_UPLOAD_COST * PLATFORM_MARKUP_MULTIPLIER * 100) / 100; // ~$0.05 - Additional samples to existing voice
export const VOICE_UPDATE_COST =
  Math.round(BASE_VOICE_UPDATE_COST * PLATFORM_MARKUP_MULTIPLIER * 100) / 100; // ~$0.10 - Update voice metadata/settings
export const CUSTOM_VOICE_TTS_MARKUP = 1.1; // 10% additional markup for using custom cloned voices (on top of platform markup)

/**
 * TTS/STT costs in USD (with 20% platform markup).
 * Based on ElevenLabs pricing.
 */
const BASE_TTS_COST_PER_1K_CHARS = 0.05; // ElevenLabs Flash/Turbo published API rate
const BASE_STT_COST_PER_MINUTE = 0.22 / 60; // ElevenLabs Scribe v1/v2 published API rate

export const TTS_COST_PER_1K_CHARS =
  Math.round(BASE_TTS_COST_PER_1K_CHARS * PLATFORM_MARKUP_MULTIPLIER * 10000) / 10000; // $0.060 per 1K chars with markup
export const STT_COST_PER_MINUTE =
  Math.round(BASE_STT_COST_PER_MINUTE * PLATFORM_MARKUP_MULTIPLIER * 10000) / 10000; // ~$0.0044 per minute with markup
export const TTS_MINIMUM_COST = 0.001; // Minimum charge for any TTS request
export const STT_MINIMUM_COST = 0.001; // Minimum charge for any STT request
