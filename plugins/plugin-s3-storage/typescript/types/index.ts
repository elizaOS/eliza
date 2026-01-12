import { z } from "zod";

/** JSON-serializable primitive values */
export type JsonPrimitive = string | number | boolean | null;

/** JSON-serializable object type */
export interface JsonObject {
  [key: string]: JsonPrimitive | JsonObject | JsonArray;
}

/** JSON-serializable array type */
export interface JsonArray extends Array<JsonPrimitive | JsonObject | JsonArray> {}

/** JSON-serializable value type */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export const FileLocationResultSchema = z.object({
  fileLocation: z.string().min(1),
});

export type FileLocationResult = z.infer<typeof FileLocationResultSchema>;

export function isFileLocationResult(value: unknown): value is FileLocationResult {
  return FileLocationResultSchema.safeParse(value).success;
}

export interface UploadResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface JsonUploadResult extends UploadResult {
  key?: string;
}

export interface S3StorageConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  uploadPath?: string;
  endpoint?: string;
  sslEnabled?: boolean;
  forcePathStyle?: boolean;
}

export interface UploadOptions {
  subDirectory?: string;
  useSignedUrl?: boolean;
  expiresIn?: number;
}

export interface JsonUploadOptions extends UploadOptions {
  fileName?: string;
}

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

export function getContentType(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}
