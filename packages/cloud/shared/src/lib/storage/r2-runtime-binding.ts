/**
 * Per-request Cloudflare R2 binding bridge.
 *
 * Shared package code cannot import Hono's `c.env`, but Workers inject native
 * R2 buckets there rather than through `process.env`. The API middleware
 * registers the current Worker binding before route handlers run.
 */

export interface RuntimeR2Object {
  text(): Promise<string>;
  /**
   * Binary access — Workers' real R2 object exposes this; the in-memory test
   * shim should populate it too. Optional on the type for back-compat with
   * tests that only need `.text()`.
   */
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/** One uploaded multipart part — mirrors Workers' `R2UploadedPart`. */
export interface RuntimeR2UploadedPart {
  partNumber: number;
  etag: string;
}

/** Live multipart upload handle — mirrors Workers' `R2MultipartUpload`. */
export interface RuntimeR2MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    value: string | ArrayBuffer | ArrayBufferView | Blob,
  ): Promise<RuntimeR2UploadedPart>;
  complete(uploadedParts: RuntimeR2UploadedPart[]): Promise<unknown>;
  abort(): Promise<unknown>;
}

export interface RuntimeR2Bucket {
  get(key: string): Promise<RuntimeR2Object | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Blob | null,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  /**
   * Multipart surface — present on the real Workers R2 binding (and miniflare);
   * optional on the type for back-compat with test shims that never touch the
   * resumable import path. Callers must fail fast when absent, never fall back
   * to buffering whole uploads in Worker memory.
   */
  createMultipartUpload?(
    key: string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<RuntimeR2MultipartUpload>;
  resumeMultipartUpload?(key: string, uploadId: string): RuntimeR2MultipartUpload;
}

let runtimeBucket: RuntimeR2Bucket | null = null;

export function setRuntimeR2Bucket(bucket: RuntimeR2Bucket | null | undefined): void {
  runtimeBucket = bucket ?? null;
}

export function getRuntimeR2Bucket(): RuntimeR2Bucket | null {
  return runtimeBucket;
}

export function runtimeR2BucketConfigured(): boolean {
  return runtimeBucket !== null;
}
