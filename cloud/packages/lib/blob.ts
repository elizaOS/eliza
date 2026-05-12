import { getRuntimeR2Bucket, runtimeR2BucketConfigured } from "@/lib/storage/r2-runtime-binding";

const DEFAULT_R2_PUBLIC_HOST = "blob.elizacloud.ai";

function getR2PublicHost(): string {
  const host = process.env.R2_PUBLIC_HOST;
  return typeof host === "string" && host.length > 0 ? host : DEFAULT_R2_PUBLIC_HOST;
}

/**
 * Trusted blob storage hosts for URL validation.
 * Used to prevent SSRF attacks by ensuring URLs point to our storage.
 */
export const TRUSTED_BLOB_HOSTS: readonly string[] = [getR2PublicHost()];

/**
 * Validates that a URL points to a trusted blob storage host.
 * Prevents SSRF attacks by ensuring we only fetch from our storage.
 *
 * @param url - URL to validate.
 * @returns True if the URL is from a trusted blob host with https protocol.
 */
export function isValidBlobUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:") {
      return false;
    }
    return TRUSTED_BLOB_HOSTS.some((host) => parsedUrl.hostname === host);
  } catch {
    return false;
  }
}

/**
 * Options for uploading a file to blob storage.
 */
export interface BlobUploadOptions {
  /** Name of the file to upload. */
  filename: string;
  /** MIME type of the file (e.g., "image/png"). */
  contentType?: string;
  /** Folder path to organize files (default: "media"). */
  folder?: string;
  /** User ID to organize files by user. */
  userId?: string;
}

/**
 * Result of a successful blob upload.
 */
export interface BlobUploadResult {
  /** Public URL of the uploaded file. */
  url: string;
  /** Pathname of the file in storage. */
  pathname: string;
  /** MIME type of the uploaded file. */
  contentType: string;
  /** Size of the file in bytes. */
  size: number;
}

function toArrayBuffer(content: Buffer | string): ArrayBuffer {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/**
 * Uploads a file to R2 storage via the runtime binding. R2 objects are public
 * via the bucket's public host (R2_PUBLIC_HOST, default "blob.elizacloud.ai").
 *
 * @param content - File content as Buffer or string.
 * @param options - Upload options including filename and metadata.
 * @returns Upload result with URL and metadata.
 * @throws Error if the runtime R2 binding is not configured.
 */
export async function uploadToBlob(
  content: Buffer | string,
  options: BlobUploadOptions,
): Promise<BlobUploadResult> {
  if (!runtimeR2BucketConfigured()) {
    throw new Error("R2 bucket binding is not configured for this runtime");
  }
  const bucket = getRuntimeR2Bucket();
  if (!bucket) {
    throw new Error("R2 bucket binding is not configured for this runtime");
  }

  const { filename, contentType, folder = "media", userId } = options;

  const timestamp = Date.now();
  const pathname = userId
    ? `${folder}/${userId}/${timestamp}-${filename}`
    : `${folder}/${timestamp}-${filename}`;

  const body = toArrayBuffer(content);
  const resolvedContentType = contentType || "application/octet-stream";

  await bucket.put(pathname, body, {
    httpMetadata: { contentType: resolvedContentType },
  });

  const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content);
  const url = `https://${getR2PublicHost()}/${pathname}`;

  return {
    url,
    pathname,
    contentType: resolvedContentType,
    size,
  };
}

/**
 * Uploads a base64-encoded image to R2 storage.
 *
 * @param base64Data - Base64 data URI (e.g., "data:image/png;base64,...").
 * @param options - Upload options (contentType is extracted from base64 data).
 * @param maxSizeMB - Maximum allowed size in MB (default: 10MB, avatars typically use 5MB).
 * @returns Upload result with URL and metadata.
 * @throws Error if base64 data format is invalid or file is too large.
 */
export async function uploadBase64Image(
  base64Data: string,
  options: Omit<BlobUploadOptions, "contentType">,
  maxSizeMB: number = 10,
): Promise<BlobUploadResult> {
  const matches = base64Data.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) {
    throw new Error("Invalid base64 data format");
  }

  const mimeType = matches[1];
  const base64Content = matches[2];

  const MAX_IMAGE_SIZE = maxSizeMB * 1024 * 1024;
  const paddingCount = (base64Content.match(/=/g) || []).length;
  const estimatedSize = Math.ceil((base64Content.length * 3) / 4) - paddingCount;

  if (estimatedSize > MAX_IMAGE_SIZE) {
    throw new Error(
      `Image too large (max ${maxSizeMB}MB). Got ${(estimatedSize / 1024 / 1024).toFixed(2)}MB`,
    );
  }

  const validImageTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
  if (!validImageTypes.includes(mimeType.toLowerCase())) {
    throw new Error(`Invalid image type: ${mimeType}. Allowed: ${validImageTypes.join(", ")}`);
  }

  const buffer = Buffer.from(base64Content, "base64");

  return uploadToBlob(buffer, {
    ...options,
    contentType: mimeType,
  });
}

/**
 * Checks if a URL is from Fal.ai CDN.
 *
 * @param url - URL to check.
 * @returns True if the URL is from Fal.ai CDN.
 */
export function isFalAiUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes("fal.media") || urlObj.hostname.includes("fal.ai");
  } catch {
    return false;
  }
}

/**
 * Downloads content from a URL and uploads it to R2 storage.
 *
 * @param sourceUrl - URL to download content from.
 * @param options - Upload options for the downloaded content.
 * @returns Upload result with URL and metadata.
 * @throws Error if the URL cannot be fetched.
 */
export async function uploadFromUrl(
  sourceUrl: string,
  options: BlobUploadOptions,
): Promise<BlobUploadResult> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = options.contentType || response.headers.get("content-type") || undefined;

  return uploadToBlob(buffer, {
    ...options,
    contentType,
  });
}

/**
 * Ensures a URL is from our storage, not Fal.ai CDN.
 *
 * If the URL is from Fal.ai, downloads and uploads it to our storage.
 * Returns our storage URL or the original URL if it's already ours or upload fails.
 *
 * @param sourceUrl - URL to ensure is from our storage.
 * @param options - Upload options and fallback behavior.
 * @returns Our storage URL or the original URL if fallback is enabled.
 * @throws Error if upload fails and fallback is disabled.
 */
export async function ensureElizaCloudUrl(
  sourceUrl: string,
  options: BlobUploadOptions & { fallbackToOriginal?: boolean },
): Promise<string> {
  if (!isFalAiUrl(sourceUrl)) {
    return sourceUrl;
  }

  try {
    const result = await uploadFromUrl(sourceUrl, options);
    return result.url;
  } catch (error) {
    console.error("[ensureElizaCloudUrl] Failed to upload Fal.ai URL to our storage:", error);
    throw error;
  }
}

/**
 * Deletes a blob from R2 storage.
 *
 * @param url - Public URL of the blob to delete (must match the trusted host).
 * @throws Error if the runtime R2 binding is not configured or the URL is not a trusted blob URL.
 */
export async function deleteBlob(url: string): Promise<void> {
  if (!runtimeR2BucketConfigured()) {
    throw new Error("R2 bucket binding is not configured for this runtime");
  }
  const bucket = getRuntimeR2Bucket();
  if (!bucket) {
    throw new Error("R2 bucket binding is not configured for this runtime");
  }
  if (!isValidBlobUrl(url)) {
    throw new Error(`Refusing to delete: URL is not a trusted blob URL: ${url}`);
  }

  const parsed = new URL(url);
  const key = parsed.pathname.replace(/^\/+/, "");
  if (!key) {
    throw new Error(`Refusing to delete: URL has no object key: ${url}`);
  }

  await bucket.delete(key);
}
