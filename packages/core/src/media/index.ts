/**
 * Media utilities for Eliza.
 *
 * Provides MIME type detection, media parsing, fetching, and format utilities.
 */

export * from "@elizaos/core/media/attachments";
export {
  type FetchLike,
  type FetchMediaOptions,
  type FetchMediaResult,
  fetchRemoteMedia,
  MediaFetchError,
  type MediaFetchErrorCode,
  readResponseWithLimit,
} from "@elizaos/core/media/fetch";
export {
  type CachedImageDescription,
  describeImageCached,
  getCachedImageDescription,
  imageDescriptionCacheKey,
  normalizeImageDescription,
  setCachedImageDescription,
} from "@elizaos/core/media/image-description-cache";
export {
  trustedLocalMediaUrl,
  VISION_IMAGE_FETCH_TIMEOUT_MS,
  VISION_IMAGE_MAX_BYTES,
} from "@elizaos/core/media/local-store";
export {
  detectMime,
  extensionForMime,
  getFileExtension,
  imageMimeFromFormat,
  isAudioFileName,
  isGifMedia,
  isVoiceCompatibleAudio,
  type MediaKind,
  mediaKindFromMime,
} from "@elizaos/core/media/mime";
