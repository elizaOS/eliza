/**
 * S3 Storage Plugin Types
 *
 * Strong types for S3 storage operations.
 */

import { z } from "zod";

/**
 * Schema for FileLocationResult validation.
 */
export const FileLocationResultSchema = z.object({
  fileLocation: z.string().min(1),
});

/**
 * Result containing a file location.
 */
export type FileLocationResult = z.infer<typeof FileLocationResultSchema>;

/**
 * Type guard for FileLocationResult.
 */
export function isFileLocationResult(value: unknown): value is FileLocationResult {
  return FileLocationResultSchema.safeParse(value).success;
}

/**
 * Result of an upload operation.
 */
export interface UploadResult {
  /** Whether the upload was successful */
  success: boolean;
  /** The URL of the uploaded file (if successful) */
  url?: string;
  /** Error message (if unsuccessful) */
  error?: string;
}

/**
 * Result of a JSON upload operation.
 */
export interface JsonUploadResult extends UploadResult {
  /** The storage key for the uploaded file */
  key?: string;
}

/**
 * Configuration for the S3 storage service.
 */
export interface S3StorageConfig {
  /** AWS access key ID */
  accessKeyId: string;
  /** AWS secret access key */
  secretAccessKey: string;
  /** AWS region */
  region: string;
  /** S3 bucket name */
  bucket: string;
  /** Optional upload path prefix */
  uploadPath?: string;
  /** Optional custom S3 endpoint */
  endpoint?: string;
  /** Whether SSL is enabled for custom endpoint */
  sslEnabled?: boolean;
  /** Whether to use path-style addressing */
  forcePathStyle?: boolean;
}

/**
 * Options for file upload.
 */
export interface UploadOptions {
  /** Subdirectory within the bucket */
  subDirectory?: string;
  /** Whether to use a signed URL */
  useSignedUrl?: boolean;
  /** Expiration time for signed URL in seconds */
  expiresIn?: number;
}

/**
 * Options for JSON upload.
 */
export interface JsonUploadOptions extends UploadOptions {
  /** Custom filename for the JSON file */
  fileName?: string;
}

/**
 * Content type mapping for file extensions.
 */
export const CONTENT_TYPES: Record<string, string> = {
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
 * Get content type for a file path.
 */
export function getContentType(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}
