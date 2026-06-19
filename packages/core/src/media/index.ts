/**
 * Media utilities for Eliza.
 *
 * Provides MIME type detection, media parsing, fetching, and format utilities.
 */

export {
	type FetchLike,
	type FetchMediaOptions,
	type FetchMediaResult,
	fetchRemoteMedia,
	MediaFetchError,
	type MediaFetchErrorCode,
} from "./fetch.js";

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
} from "./mime.js";
