/**
 * Per-request Cloudflare R2 binding bridge.
 *
 * Shared package code cannot import Hono's `c.env`, but Workers inject native
 * R2 buckets there rather than through `process.env`. The API middleware
 * registers the current Worker binding before route handlers run.
 */

export interface RuntimeR2Object {
  /** Native R2 response body. Absent only on legacy narrow test shims. */
  readonly body?: ReadableStream<Uint8Array>;
  readonly bodyUsed?: boolean;
  /** Exact-generation metadata returned alongside a native R2 GET. */
  readonly version?: string;
  readonly size?: number;
  readonly etag?: string;
  readonly checksums?: RuntimeR2ObjectMetadata["checksums"];
  readonly customMetadata?: Record<string, string>;
  text(): Promise<string>;
  /**
   * Binary access — Workers' real R2 object exposes this; the in-memory test
   * shim should populate it too. Optional on the type for back-compat with
   * tests that only need `.text()`.
   */
  arrayBuffer?(): Promise<ArrayBuffer>;
}

/** Metadata returned by the native Workers `R2Bucket.head()` operation. */
export interface RuntimeR2ObjectMetadata {
  /** Key is populated on list results and omitted on direct HEAD results. */
  key?: string;
  /** Opaque upload generation assigned by R2. */
  version?: string;
  size: number;
  etag: string;
  uploaded?: Date;
  checksums?: {
    md5?: ArrayBuffer;
    sha1?: ArrayBuffer;
    sha256?: ArrayBuffer;
  };
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}

export interface RuntimeR2ListOptions {
  prefix?: string;
  cursor?: string;
  delimiter?: string;
  limit?: number;
  include?: Array<"httpMetadata" | "customMetadata">;
}

export interface RuntimeR2Objects {
  objects: RuntimeR2ObjectMetadata[];
  truncated: boolean;
  cursor?: string;
}

export interface RuntimeR2PutOptions {
  /** Native R2 conditional write contract (for example `If-None-Match: *`). */
  onlyIf?:
    | Headers
    | {
        etagMatches?: string;
        etagDoesNotMatch?: string;
        uploadedBefore?: Date;
        uploadedAfter?: Date;
      };
  httpMetadata?: {
    contentType?: string;
  };
  customMetadata?: Record<string, string>;
  sha256?: ArrayBuffer | ArrayBufferView | string;
}

export interface RuntimeR2GetOptions {
  /** Native R2 conditional GET contract. */
  onlyIf?:
    | Headers
    | {
        etagMatches?: string;
        etagDoesNotMatch?: string;
        uploadedBefore?: Date;
        uploadedAfter?: Date;
      };
}

export interface RuntimeR2Bucket {
  /**
   * Optional only for backwards compatibility with narrow non-storage test
   * shims. Real R2 bindings always expose `head`; lifecycle operations fail
   * closed when a registered shim does not.
   */
  head?(key: string): Promise<RuntimeR2ObjectMetadata | null>;
  get(key: string, options?: RuntimeR2GetOptions): Promise<RuntimeR2Object | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array> | null,
    options?: RuntimeR2PutOptions,
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list?(options?: RuntimeR2ListOptions): Promise<RuntimeR2Objects>;
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
