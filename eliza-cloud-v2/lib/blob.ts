import { put, del, list } from "@vercel/blob";

/**
 * Trusted blob storage hosts for URL validation.
 * Used to prevent SSRF attacks by ensuring URLs point to our storage.
 */
export const TRUSTED_BLOB_HOSTS = [
  "blob.vercel-storage.com",
  "public.blob.vercel-storage.com",
];

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
    // Require HTTPS protocol to prevent protocol-based attacks
    if (parsedUrl.protocol !== "https:") {
      return false;
    }
    // Vercel Blob URLs have random subdomain prefixes (e.g., l5fpqchmvmrcwa0k.public.blob.vercel-storage.com)
    // Using endsWith is safe because Vercel controls all subdomains of blob.vercel-storage.com
    return TRUSTED_BLOB_HOSTS.some(
      (host) =>
        parsedUrl.hostname === host || parsedUrl.hostname.endsWith(`.${host}`),
    );
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

/**
 * Uploads a file to Vercel Blob storage.
 *
 * @param content - File content as Buffer or string.
 * @param options - Upload options including filename and metadata.
 * @returns Upload result with URL and metadata.
 * @throws Error if BLOB_READ_WRITE_TOKEN is not configured.
 */
export async function uploadToBlob(
  content: Buffer | string,
  options: BlobUploadOptions,
): Promise<BlobUploadResult> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  }

  const { filename, contentType, folder = "media", userId } = options;

  // Create a hierarchical pathname: folder/userId/timestamp-filename
  const timestamp = Date.now();
  const pathname = userId
    ? `${folder}/${userId}/${timestamp}-${filename}`
    : `${folder}/${timestamp}-${filename}`;

  const blob = await put(pathname, content, {
    access: "public",
    contentType,
    addRandomSuffix: false, // We're already adding timestamp for uniqueness
  });

  // Calculate size from the content
  const size = Buffer.isBuffer(content)
    ? content.length
    : Buffer.byteLength(content);

  return {
    url: blob.url,
    pathname: blob.pathname,
    contentType: blob.contentType || contentType || "application/octet-stream",
    size,
  };
}

/**
 * Uploads a base64-encoded image to Vercel Blob storage.
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
  // Extract the base64 data and mime type
  const matches = base64Data.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) {
    throw new Error("Invalid base64 data format");
  }

  const mimeType = matches[1];
  const base64Content = matches[2];

  // Validate file size before converting to buffer
  const MAX_IMAGE_SIZE = maxSizeMB * 1024 * 1024;
  // Account for base64 padding characters when calculating size
  const paddingCount = (base64Content.match(/=/g) || []).length;
  const estimatedSize =
    Math.ceil((base64Content.length * 3) / 4) - paddingCount;

  if (estimatedSize > MAX_IMAGE_SIZE) {
    throw new Error(
      `Image too large (max ${maxSizeMB}MB). Got ${(estimatedSize / 1024 / 1024).toFixed(2)}MB`,
    );
  }

  // Validate MIME type - only allow images
  const validImageTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
  ];
  if (!validImageTypes.includes(mimeType.toLowerCase())) {
    throw new Error(
      `Invalid image type: ${mimeType}. Allowed: ${validImageTypes.join(", ")}`,
    );
  }

  const buffer = Buffer.from(base64Content, "base64");

  return uploadToBlob(buffer, {
    ...options,
    contentType: mimeType,
  });
}

/**
 * Uploads a buffer directly to Vercel Blob storage.
 *
 * @param buffer - Buffer to upload.
 * @param filename - Filename for the blob.
 * @param contentType - MIME type of the content.
 * @returns Upload result with URL and metadata.
 */
export async function uploadFromBuffer(
  buffer: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  const result = await uploadToBlob(buffer, {
    filename,
    contentType,
  });
  return result.url;
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
    return (
      urlObj.hostname.includes("fal.media") ||
      urlObj.hostname.includes("fal.ai")
    );
  } catch {
    return false;
  }
}

/**
 * Downloads content from a URL and uploads it to Vercel Blob storage.
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
  const contentType =
    options.contentType || response.headers.get("content-type") || undefined;

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
  // If it's not a Fal.ai URL, return as-is
  if (!isFalAiUrl(sourceUrl)) {
    return sourceUrl;
  }

  // It's a Fal.ai URL - download and upload to our storage
  try {
    const result = await uploadFromUrl(sourceUrl, options);
    return result.url;
  } catch (error) {
    console.error(
      "[ensureElizaCloudUrl] Failed to upload Fal.ai URL to our storage:",
      error,
    );

    // If fallback is allowed, return original URL
    if (options.fallbackToOriginal !== false) {
      console.warn("[ensureElizaCloudUrl] Falling back to original Fal.ai URL");
      return sourceUrl;
    }

    // Otherwise, throw the error
    throw error;
  }
}

/**
 * Deletes a blob from storage.
 *
 * @param url - URL of the blob to delete.
 * @throws Error if BLOB_READ_WRITE_TOKEN is not configured.
 */
export async function deleteBlob(url: string): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  }

  await del(url);
}

/**
 * Lists blobs in storage with an optional prefix filter.
 *
 * @param prefix - Optional prefix to filter blobs by pathname.
 * @returns List of blobs matching the prefix (up to 1000 results).
 * @throws Error if BLOB_READ_WRITE_TOKEN is not configured.
 */
export async function listBlobs(prefix?: string) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured");
  }

  return await list({
    prefix,
    limit: 1000,
  });
}
