/**
 * Instagram plugin constants
 */

/** Service name for the Instagram plugin */
export const INSTAGRAM_SERVICE_NAME = "instagram";

/** Maximum caption length for Instagram posts */
export const MAX_CAPTION_LENGTH = 2200;

/** Maximum characters for a comment */
export const MAX_COMMENT_LENGTH = 1000;

/** Maximum characters for a DM */
export const MAX_DM_LENGTH = 1000;

/** Maximum hashtags per post */
export const MAX_HASHTAGS = 30;

/** Supported media types */
export const SUPPORTED_MEDIA_TYPES = {
  PHOTO: "photo",
  VIDEO: "video",
  CAROUSEL: "carousel",
  REEL: "reel",
  STORY: "story",
  IGTV: "igtv",
} as const;

/** Instagram event type prefix */
export const EVENT_PREFIX = "INSTAGRAM_";
