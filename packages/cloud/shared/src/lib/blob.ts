/**
 * Owns cloud blob URL validation, bounded remote ingestion, and R2 persistence
 * for backend service consumers.
 */
import { ElizaError } from "@elizaos/core";

import { safeFetch } from "./security/safe-fetch";
import { getRuntimeR2Bucket, runtimeR2BucketConfigured } from "./storage/r2-runtime-binding";

const DEFAULT_R2_PUBLIC_HOST = "blob.eliza.app";

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
 * via the bucket's public host (R2_PUBLIC_HOST, default "blob.eliza.app").
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
 * Upper bound on the bytes uploadFromUrl pulls through a caller-controlled
 * URL. The body is streamed and cancelled as soon as the running total
 * exceeds the cap, so a missing or lying Content-Length cannot force an
 * unbounded allocation before the payload lands on the public blob host.
 */
const UPLOAD_FROM_URL_MAX_BYTES = 25 * 1024 * 1024;
const UPLOAD_FROM_URL_TIMEOUT_MS = 15_000;

/**
 * Reads a response body under a hard byte cap, cancelling the stream as soon
 * as the running total exceeds maxBytes instead of materializing the payload
 * first. A declared Content-Length above the cap is rejected before any byte
 * is read. Falls back to a post-read check only when the response exposes no
 * stream.
 */
async function readResponseBodyWithCap(
  response: Response,
  maxBytes: number,
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // error-policy:J6 Cancellation is best-effort teardown after the
      // byte-limit failure has already been established.
    }
    throw new Error(
      `Failed to fetch URL: content length ${declaredLength} exceeds the ${maxBytes}-byte cap (${sourceUrl})`,
    );
  }

  const body = response.body;
  if (!body) {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.length > maxBytes) {
      throw new Error(
        `Failed to fetch URL: payload exceeds the ${maxBytes}-byte cap (${sourceUrl})`,
      );
    }
    return fallback;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancelReaderAfterAbort = async (): Promise<void> => {
    try {
      await reader.cancel(signal?.reason);
    } catch {
      // error-policy:J6 The deadline failure is already authoritative; stream
      // cancellation is best-effort teardown for a non-cooperative body.
    }
  };
  const onAbort = (): void => {
    void cancelReaderAfterAbort();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {
    onAbort();
  }
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.length) {
        total += value.length;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // error-policy:J6 Cancellation is best-effort teardown after the
            // byte-limit failure has already been established.
          }
          throw new Error(
            `Failed to fetch URL: payload exceeds the ${maxBytes}-byte cap (${sourceUrl})`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // error-policy:J6 Stream lock release is best-effort teardown.
    }
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

/**
 * Downloads content from a URL and uploads it to R2 storage.
 *
 * The fetch goes through the SSRF-hardened safeFetch — every redirect hop is
 * re-validated against the outbound guard and, on Node, pinned to the
 * validated IP — and the body streams under UPLOAD_FROM_URL_MAX_BYTES, so a
 * caller-controlled URL can neither read internal-network targets nor exhaust
 * memory on its way onto the public blob host.
 *
 * @param sourceUrl - URL to download content from.
 * @param options - Upload options for the downloaded content.
 * @returns Upload result with URL and metadata.
 * @throws Error if the outbound guard rejects the URL, the fetch fails, or the payload exceeds the byte cap.
 */
export async function uploadFromUrl(
  sourceUrl: string,
  options: BlobUploadOptions,
): Promise<BlobUploadResult> {
  const controller = new AbortController();
  const timeoutError = new ElizaError(
    `Remote blob fetch timed out after ${UPLOAD_FROM_URL_TIMEOUT_MS}ms`,
    {
      code: "REMOTE_BLOB_FETCH_TIMEOUT",
      context: { timeoutMs: UPLOAD_FROM_URL_TIMEOUT_MS },
      severity: "ephemeral",
    },
  );
  let rejectDeadline: (error: ElizaError) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeout = setTimeout(() => {
    controller.abort(timeoutError);
    // Reject independently of AbortSignal cooperation. DNS resolution and
    // arbitrary response streams are not required to observe the signal.
    rejectDeadline(timeoutError);
  }, UPLOAD_FROM_URL_TIMEOUT_MS);
  timeout.unref?.();

  let response: Response;
  let buffer: Buffer;
  try {
    ({ response, buffer } = await Promise.race([
      (async () => {
        const fetchedResponse = await safeFetch(sourceUrl, { signal: controller.signal });
        if (!fetchedResponse.ok) {
          try {
            await fetchedResponse.body?.cancel();
          } catch {
            // error-policy:J6 The HTTP status failure is authoritative; body
            // cancellation is best-effort teardown of the remote connection.
          }
          throw new Error(`Failed to fetch URL: ${fetchedResponse.statusText}`);
        }
        const fetchedBuffer = await readResponseBodyWithCap(
          fetchedResponse,
          UPLOAD_FROM_URL_MAX_BYTES,
          sourceUrl,
          controller.signal,
        );
        return { response: fetchedResponse, buffer: fetchedBuffer };
      })(),
      deadline,
    ]));
  } finally {
    clearTimeout(timeout);
  }

  const contentType = options.contentType || response.headers.get("content-type") || undefined;
  return uploadToBlob(buffer, {
    ...options,
    contentType,
  });
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
