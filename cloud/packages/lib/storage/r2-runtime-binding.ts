/**
 * Per-request Cloudflare R2 binding bridge.
 *
 * Shared package code cannot import Hono's `c.env`, but Workers inject native
 * R2 buckets there rather than through `process.env`. The API middleware
 * registers the current Worker binding before route handlers run.
 */

export interface RuntimeR2Object {
  text(): Promise<string>;
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
