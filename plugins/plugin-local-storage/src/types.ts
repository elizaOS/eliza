/**
 * JSON-serializable primitive values.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON-serializable object type.
 */
export interface JsonObject {
  [key: string]: JsonPrimitive | JsonObject | JsonArray;
}

/**
 * JSON-serializable array type.
 */
export type JsonArray = Array<JsonPrimitive | JsonObject | JsonArray>;

/**
 * JSON-serializable value type.
 */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/**
 * Result of a binary upload operation.
 *
 * Mirrors the shape returned by the removed `@elizaos/plugin-s3-storage`
 * `AwsS3Service` so callers can be retargeted without refactoring.
 */
export interface UploadResult {
  success: boolean;
  /** Absolute `file://` URL for the stored object on success. */
  url?: string;
  /** Human-readable error message on failure. */
  error?: string;
}

/**
 * Result of a JSON upload operation. Same as `UploadResult` plus the
 * resolved storage key.
 */
export interface JsonUploadResult extends UploadResult {
  /** Storage key (relative path under the storage root). */
  key?: string;
}

/**
 * Mapping from filename extension to MIME type. Mirrors the table that
 * shipped with the deprecated S3 plugin so behavior matches for callers
 * that depended on the original content-type inference.
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".webm": "video/webm",
};

/**
 * Resolve a Content-Type by extension. Falls back to
 * `application/octet-stream` when the extension is unknown.
 */
export function getContentType(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = filePath.substring(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
