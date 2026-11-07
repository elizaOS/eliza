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

/**
 * Normalize a MIME type from HTTP headers.
 */
function normalizeHeaderMime(mime?: string | null): string | undefined {
	if (!mime) return undefined;
	const cleaned = mime.split(";")[0].trim().toLowerCase();
	return cleaned || undefined;
}

/**
 * Get the file extension from a path or URL.
 */
export function getFileExtension(filePath?: string | null): string | undefined {
	if (!filePath) return undefined;
	let candidate = filePath;
	try {
		if (/^https?:\/\//i.test(filePath)) {
			candidate = new URL(filePath).pathname;
		}
	} catch {
		// error-policy:J3 URL paths are untrusted input; malformed URLs are
		// treated as plain paths without partial decoding.
	}
	// Only the last path segment can carry an extension; splitting the whole
	// path on "." would treat a dot in a directory name (or a dotless URL
	// pathname) as an extension boundary and return garbage like ".2/notes".
	const base = candidate.split(/[\\/]/).pop() ?? "";
	const dotIndex = base.lastIndexOf(".");
	if (dotIndex === -1) return undefined;
	const ext = base.slice(dotIndex + 1).toLowerCase();
	return ext ? `.${ext}` : undefined;
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

/** Lazily load byte detection only when a media caller supplies bytes. */
export async function sniffMime(
	buffer?: Buffer | Uint8Array,
): Promise<string | undefined> {
	if (!buffer) return undefined;
	const { fileTypeFromBuffer } = await import("file-type");
	return (await fileTypeFromBuffer(buffer))?.mime;
}
