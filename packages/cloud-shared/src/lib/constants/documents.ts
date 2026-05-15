/**
 * Shared constants for document file processing.
 * Used across pre-upload, queue, and processing services.
 */

export const DOCUMENT_CONSTANTS = {
  /** Maximum number of files per upload request */
  MAX_FILES_PER_REQUEST: 5,
  /** Maximum size per individual file (5MB) */
  MAX_FILE_SIZE: 5 * 1024 * 1024,
  /** Maximum total size for all files combined (5MB) - enforced for serverless memory constraints */
  MAX_BATCH_SIZE: 5 * 1024 * 1024,
  /** Timeout for downloading files from blob storage (30s) */
  BLOB_FETCH_TIMEOUT_MS: 30_000,
} as const;

export const ALLOWED_EXTENSIONS = [
  ".pdf",
  ".txt",
  ".md",
  ".doc",
  ".docx",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".csv",
] as const;

/**
 * Text-based extensions that are allowed with application/octet-stream content type.
 * Browsers may send these file types as octet-stream instead of their proper MIME type.
 */
export const TEXT_EXTENSIONS_FOR_OCTET_STREAM = [
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".yaml",
  ".yml",
  ".xml",
] as const;

export const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/json",
  "application/xml",
  "text/xml",
  "application/x-yaml",
  "text/yaml",
  "text/csv",
  "application/octet-stream",
] as const;

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/**
 * Characters that are not allowed in filenames for security.
 * Prevents path traversal attacks and unexpected storage key structures.
 */
const UNSAFE_FILENAME_CHARS = /[/\\:*?"<>|]/;

/**
 * Validates that a filename doesn't contain path-unsafe characters.
 * Prevents path traversal attacks like "foo/../../bar.txt".
 *
 * @param filename - The filename to validate.
 * @returns True if the filename is safe to use.
 */
export function isValidFilename(filename: string): boolean {
  if (!filename || typeof filename !== "string") return false;
  if (UNSAFE_FILENAME_CHARS.test(filename)) return false;
  if (filename.includes("..")) return false;
  return true;
}
