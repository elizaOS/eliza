/**
 * Per-request Cloudflare R2 binding bridge.
 *
 * Shared package code cannot import Hono's `c.env`, but Workers inject native
 * R2 buckets there rather than through `process.env`. The API middleware
 * registers the current Worker binding before route handlers run.
 */

export type RuntimeR2Range =
  | { readonly offset: number; readonly length?: number }
  | { readonly offset?: number; readonly length: number }
  | { readonly suffix: number };

export interface RuntimeR2HttpMetadata {
  readonly contentType?: string;
  readonly contentLanguage?: string;
  readonly contentDisposition?: string;
  readonly contentEncoding?: string;
  readonly cacheControl?: string;
  readonly cacheExpiry?: Date;
}

export interface RuntimeR2Conditional {
  readonly etagMatches?: string;
  readonly etagDoesNotMatch?: string;
  readonly uploadedBefore?: Date;
  readonly uploadedAfter?: Date;
  readonly secondsGranularity?: boolean;
}

export interface RuntimeR2Object extends Partial<RuntimeR2ObjectMetadata> {
  /**
   * Native R2 response body. A failed conditional GET returns metadata without
   * a body; old narrow test shims can also omit it.
   */
  readonly body?: ReadableStream<Uint8Array>;
  readonly bodyUsed?: boolean;
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
  /** Exact object key returned by the native binding. */
  key?: string;
  /** Opaque upload generation assigned by R2. */
  version?: string;
  size: number;
  etag: string;
  /** HTTP-ready quoted entity tag returned by R2. */
  httpEtag?: string;
  uploaded?: Date;
  httpMetadata?: RuntimeR2HttpMetadata;
  range?: RuntimeR2Range;
  checksums?: {
    md5?: ArrayBuffer;
    sha1?: ArrayBuffer;
    sha256?: ArrayBuffer;
    sha384?: ArrayBuffer;
    sha512?: ArrayBuffer;
  };
  customMetadata?: Record<string, string>;
}

export interface RuntimeR2PutOptions {
  /** Native R2 conditional write contract (for example `If-None-Match: *`). */
  onlyIf?: Headers | RuntimeR2Conditional;
  httpMetadata?: RuntimeR2HttpMetadata;
  customMetadata?: Record<string, string>;
  sha256?: ArrayBuffer | ArrayBufferView | string;
}

export interface RuntimeR2GetOptions {
  /** Native R2 conditional GET contract. */
  onlyIf?: Headers | RuntimeR2Conditional;
  /** Native single-range GET contract. */
  range?: Headers | RuntimeR2Range;
}

export interface RuntimeR2ConditionalGetOptions extends RuntimeR2GetOptions {
  onlyIf: Headers | RuntimeR2Conditional;
}

export interface RuntimeR2Bucket {
  /**
   * Optional only for backwards compatibility with narrow non-storage test
   * shims. Real R2 bindings always expose `head`; lifecycle operations fail
   * closed when a registered shim does not.
   */
  head?(key: string): Promise<RuntimeR2ObjectMetadata | null>;
  get(
    key: string,
    options: RuntimeR2ConditionalGetOptions,
  ): Promise<RuntimeR2Object | RuntimeR2ObjectMetadata | null>;
  get(key: string, options?: RuntimeR2GetOptions): Promise<RuntimeR2Object | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Blob | null,
    options?: RuntimeR2PutOptions,
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
