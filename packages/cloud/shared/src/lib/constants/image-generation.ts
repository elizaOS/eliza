/**
 * Shared constants for image generation across miniapp and main app
 */

/**
 * Size limits for uploads
 */
export const MAX_IMAGE_SIZE_MB = 10;
export const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

/**
 * Rate limiting for auto-image generation
 */
export const MIN_IMAGE_INTERVAL_MS = 60 * 1000; // 1 minute between auto-generated images
