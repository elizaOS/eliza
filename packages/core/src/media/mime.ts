/**
 * MIME type detection and media utilities for Eliza.
 *
 * Provides robust MIME type detection from file buffers, headers, and extensions.
 */

// Lazy-loaded file-type module for MIME sniffing
type FileTypeResult = { ext: string; mime: string } | undefined;
type FileTypeFromBuffer = (
	buffer: ArrayBuffer | Uint8Array,
) => Promise<FileTypeResult>;

let fileTypeModule:
	| { fileTypeFromBuffer: FileTypeFromBuffer }
	| null
	| undefined;

async function getFileTypeFromBuffer(): Promise<FileTypeFromBuffer | null> {
	if (fileTypeModule === undefined) {
		try {
			fileTypeModule = await import("file-type");
		} catch {
			fileTypeModule = null;
		}
	}
	return fileTypeModule?.fileTypeFromBuffer ?? null;
}

/** Media kind categories */
export type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

/** Map common MIME types to preferred file extensions */
const EXT_BY_MIME: Record<string, string> = {
	"image/heic": ".heic",
	"image/heif": ".heif",
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"audio/ogg": ".ogg",
	"audio/mpeg": ".mp3",
	"audio/x-m4a": ".m4a",
	"audio/mp4": ".m4a",
	"video/mp4": ".mp4",
	"video/quicktime": ".mov",
	"application/pdf": ".pdf",
	"application/json": ".json",
	"application/zip": ".zip",
	"application/gzip": ".gz",
	"application/x-tar": ".tar",
	"application/x-7z-compressed": ".7z",
	"application/vnd.rar": ".rar",
	"application/msword": ".doc",
	"application/vnd.ms-excel": ".xls",
	"application/vnd.ms-powerpoint": ".ppt",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		".docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation":
		".pptx",
	"text/csv": ".csv",
	"text/plain": ".txt",
	"text/markdown": ".md",
};

/** Reverse map: extension to MIME */
const MIME_BY_EXT: Record<string, string> = {
	...Object.fromEntries(
		Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
	),
	".jpeg": "image/jpeg",
};

/** Audio file extensions */
const AUDIO_FILE_EXTENSIONS = new Set([
	".aac",
	".flac",
	".m4a",
	".mp3",
	".oga",
	".ogg",
	".opus",
	".wav",
]);

/** Voice-compatible audio extensions (Opus/Ogg) */
const VOICE_AUDIO_EXTENSIONS = new Set([".oga", ".ogg", ".opus"]);

/**
 * Normalize a MIME type from HTTP headers.
 */
function normalizeHeaderMime(mime?: string | null): string | undefined {
	if (!mime) return undefined;
	const cleaned = mime.split(";")[0]?.trim().toLowerCase();
	return cleaned || undefined;
}

/**
 * Detect MIME type from a buffer using magic bytes.
 */
async function sniffMime(
	buffer?: Buffer | Uint8Array,
): Promise<string | undefined> {
	if (!buffer) return undefined;
	try {
		const fileTypeFromBuffer = await getFileTypeFromBuffer();
		if (!fileTypeFromBuffer) return undefined;
		const type = await fileTypeFromBuffer(buffer);
		return type?.mime ?? undefined;
	} catch {
		return undefined;
	}
}

/**
 * Get the file extension from a path or URL.
 */
export function getFileExtension(filePath?: string | null): string | undefined {
	if (!filePath) return undefined;
	try {
		if (/^https?:\/\//i.test(filePath)) {
			const url = new URL(filePath);
			const ext = url.pathname.split(".").pop()?.toLowerCase();
			return ext ? `.${ext}` : undefined;
		}
	} catch {
		// fall back to plain path parsing
	}
	const parts = filePath.split(".");
	if (parts.length < 2) return undefined;
	return `.${parts.pop()?.toLowerCase()}`;
}

/**
 * Check if a MIME type is generic/container type.
 */
function isGenericMime(mime?: string): boolean {
	if (!mime) return true;
	const m = mime.toLowerCase();
	return m === "application/octet-stream" || m === "application/zip";
}

/**
 * Detect MIME type from buffer, headers, and/or file path.
 * Prioritizes sniffed types over extension-based detection.
 */
export async function detectMime(opts: {
	buffer?: Buffer | Uint8Array;
	headerMime?: string | null;
	filePath?: string;
}): Promise<string | undefined> {
	const ext = getFileExtension(opts.filePath);
	const extMime = ext ? MIME_BY_EXT[ext] : undefined;
	const headerMime = normalizeHeaderMime(opts.headerMime);
	const sniffed = await sniffMime(opts.buffer);

	// Prefer sniffed types, but don't let generic container types override
	// a more specific extension mapping (e.g. XLSX vs ZIP).
	if (sniffed && (!isGenericMime(sniffed) || !extMime)) {
		return sniffed;
	}
	if (extMime) return extMime;
	if (headerMime && !isGenericMime(headerMime)) return headerMime;
	if (sniffed) return sniffed;
	if (headerMime) return headerMime;

	return undefined;
}

/**
 * Get the file extension for a MIME type.
 */
export function extensionForMime(mime?: string | null): string | undefined {
	if (!mime) return undefined;
	return EXT_BY_MIME[mime.toLowerCase()];
}

/**
 * Check if a file appears to be an audio file by extension.
 */
export function isAudioFileName(fileName?: string | null): boolean {
	const ext = getFileExtension(fileName);
	return ext ? AUDIO_FILE_EXTENSIONS.has(ext) : false;
}

/**
 * Check if media is a GIF.
 */
export function isGifMedia(opts: {
	contentType?: string | null;
	fileName?: string | null;
}): boolean {
	if (opts.contentType?.toLowerCase() === "image/gif") return true;
	return getFileExtension(opts.fileName) === ".gif";
}

/**
 * Check if audio is voice-compatible (Opus/Ogg format).
 */
export function isVoiceCompatibleAudio(opts: {
	contentType?: string | null;
	fileName?: string | null;
}): boolean {
	const mime = opts.contentType?.toLowerCase();
	if (mime && (mime.includes("ogg") || mime.includes("opus"))) return true;
	const ext = getFileExtension(opts.fileName);
	return ext ? VOICE_AUDIO_EXTENSIONS.has(ext) : false;
}

/**
 * Get media kind from MIME type.
 */
export function mediaKindFromMime(mime?: string | null): MediaKind {
	if (!mime) return "unknown";
	const m = mime.toLowerCase();
	if (m.startsWith("image/")) return "image";
	if (m.startsWith("audio/")) return "audio";
	if (m.startsWith("video/")) return "video";
	if (
		m.startsWith("application/pdf") ||
		m.startsWith("application/msword") ||
		m.startsWith("application/vnd.ms-") ||
		m.startsWith("application/vnd.openxmlformats") ||
		m.startsWith("text/")
	) {
		return "document";
	}
	return "unknown";
}

/**
 * Get image MIME type from format name.
 */
export function imageMimeFromFormat(
	format?: string | null,
): string | undefined {
	if (!format) return undefined;
	switch (format.toLowerCase()) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "heic":
			return "image/heic";
		case "heif":
			return "image/heif";
		case "png":
			return "image/png";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		default:
			return undefined;
	}
}
