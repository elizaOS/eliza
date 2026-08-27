/** Provides inline and object-backed storage for cloud service payloads. */

import { createHash } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { sha256Bytes, sha256Hex } from "../crypto/worker";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import type { ObjectNamespace } from "./object-namespace";
import {
  getRuntimeR2Bucket,
  type RuntimeR2Bucket,
  type RuntimeR2ObjectMetadata,
  runtimeR2BucketConfigured,
} from "./r2-runtime-binding";
import {
  getObjectStorageClient,
  getObjectStorageProvider,
  getSingleAttemptObjectStorageClient,
  type ObjectStorageProvider,
  objectStorageConfigured,
} from "./s3-compatible-client";

export type ObjectStorageMode = "inline" | "r2";

export interface OffloadedField<T> {
  value: T | null;
  storage: ObjectStorageMode;
  key: string | null;
}

export type ObjectStorageTransport = "worker-r2-binding" | "s3-compatible";

export type ObjectChecksumReceipt =
  | {
      algorithm: "sha256" | "sha1" | "md5";
      encoding: "base64";
      value: string;
    }
  | {
      /** ETags are opaque validators, not assumed to be content hashes. */
      algorithm: "etag";
      encoding: "opaque";
      value: string;
    };

export interface Sha256ChecksumReceipt {
  algorithm: "sha256";
  encoding: "base64";
  value: string;
}

export interface ObjectMetadataReceipt {
  sizeBytes: number;
  checksum: ObjectChecksumReceipt;
}

export type ObjectLocatorVersionSource = "provider" | "etag" | "checksum" | "none";

/**
 * Privacy-safe identity of the exact storage location observed by a HEAD.
 * The complete object key is deliberately excluded; callers retain it locally
 * and the digest prevents accidentally pairing this receipt with another key.
 */
export class ObjectLocatorReceipt {
  readonly transport: ObjectStorageTransport;
  readonly provider: ObjectStorageProvider;
  readonly endpointAlias: string;
  readonly backendIdentityFingerprint: string;
  readonly bucket: string;
  readonly region: string;
  readonly keyFingerprint: string;
  readonly version: string | null;
  readonly versionSource: ObjectLocatorVersionSource;

  constructor(input: {
    transport: ObjectStorageTransport;
    provider: ObjectStorageProvider;
    endpointAlias: string;
    backendIdentityFingerprint: string;
    bucket: string;
    region: string;
    keyFingerprint: string;
    version: string | null;
    versionSource: ObjectLocatorVersionSource;
  }) {
    this.transport = input.transport;
    this.provider = input.provider;
    this.endpointAlias = input.endpointAlias;
    this.backendIdentityFingerprint = input.backendIdentityFingerprint;
    this.bucket = input.bucket;
    this.region = input.region;
    this.keyFingerprint = input.keyFingerprint;
    this.version = input.version;
    this.versionSource = input.versionSource;
    // The internal GC needs the physical locator, but an API accidentally
    // serializing a receipt must not disclose deployment topology.
    Object.defineProperty(this, "bucket", { enumerable: false });
    Object.defineProperty(this, "region", { enumerable: false });
    Object.defineProperty(this, "endpointAlias", { enumerable: false });
    Object.freeze(this);
  }

  toJSON(): {
    transport: ObjectStorageTransport;
    provider: ObjectStorageProvider;
    backendIdentityFingerprint: string;
    keyFingerprint: string;
    version: string | null;
    versionSource: ObjectLocatorVersionSource;
  } {
    return {
      transport: this.transport,
      provider: this.provider,
      backendIdentityFingerprint: this.backendIdentityFingerprint,
      keyFingerprint: this.keyFingerprint,
      version: this.version,
      versionSource: this.versionSource,
    };
  }
}

export type ObjectHeadReceipt =
  | {
      status: "present";
      locator: ObjectLocatorReceipt;
      metadata: ObjectMetadataReceipt;
    }
  | {
      status: "absent";
      locator: ObjectLocatorReceipt;
      metadata: null;
    };

export interface ObjectDeleteTarget {
  /** Exact immutable object key held by the durable catalog. */
  key: string;
  /** Receipt from a prior `headObject` for this exact key and backend. */
  locator: ObjectLocatorReceipt;
}

/** Complete private locator required to read one immutable object generation. */
export interface ExactObjectReadLocator {
  /** Exact immutable object key held by the durable catalogue. */
  readonly key: string;
  /** Persisted provider/backend/generation receipt for the key. */
  readonly receipt: ObjectLocatorReceipt;
}

export interface ExactObjectReadReceipt {
  /** The provider generation whose complete body was verified. */
  readonly locator: ObjectLocatorReceipt;
  /** Byte length and ciphertext SHA-256 verified over the streamed body. */
  readonly metadata: ObjectMetadataReceipt & {
    checksum: Sha256ChecksumReceipt;
  };
  readonly verifiedComplete: true;
}

/**
 * A pending exact read. Declared metadata is not a proof: callers must drain
 * `body` and await `completion` before publishing a replication/restore receipt.
 */
export interface ExactObjectRead {
  readonly body: ReadableStream<Uint8Array>;
  readonly declaredMetadata: ObjectMetadataReceipt & {
    checksum: Sha256ChecksumReceipt;
  };
  readonly completion: Promise<ExactObjectReadReceipt>;
}

export interface GetExactObjectInput {
  readonly locator: ExactObjectReadLocator;
  readonly expectedSize: number;
  /** Canonical lowercase hex SHA-256 of the encrypted bytes. */
  readonly expectedCipherSha256: string;
  readonly signal?: AbortSignal;
  /** Absolute wall-clock deadline. */
  readonly deadline?: Date;
}

export interface ObjectDeleteReceipt {
  status: "deleted" | "already-absent";
  /** The location actually checked. Never contains the complete object key. */
  locator: ObjectLocatorReceipt;
  /** Metadata observed before deletion, or null when already absent. */
  metadata: ObjectMetadataReceipt | null;
  /** A provider request id when the transport exposes one. */
  providerRequestId: string | null;
  verifiedAbsent: true;
}

export interface ImmutableObjectUploadReceipt {
  /** The exact location and generation proven by the post-write HEAD. */
  locator: ObjectLocatorReceipt;
  /** The byte length and SHA-256 proven by the post-write HEAD. */
  metadata: ObjectMetadataReceipt & {
    checksum: Sha256ChecksumReceipt;
  };
  verifiedPresent: true;
}

/** Caller cancellation plus an absolute wall-clock bound for provider I/O. */
export interface ObjectRequestControl {
  readonly signal?: AbortSignal;
  readonly deadline?: Date;
}

export interface PutImmutableObjectInput extends ObjectRequestControl {
  readonly key: string;
  readonly body: ArrayBuffer | Uint8Array;
  readonly contentType?: string;
  /**
   * Transfer this exact mutable byte range to the storage boundary. The bytes
   * are wiped before settlement; callers must not read or mutate them again.
   */
  readonly transferBodyOwnership?: boolean;
  /**
   * Fenced authority check run immediately before every provider PUT attempt.
   * A rejection prevents both the PUT and any response-loss reconciliation.
   */
  readonly beforeWriteAttempt?: () => Promise<void>;
}

/**
 * Single-PUT uploads are intentionally smaller than the Worker memory limit.
 * Larger backup artifacts must use the future streaming/multipart primitive.
 */
export const MAX_IMMUTABLE_SINGLE_PUT_BYTES = 32 * 1024 * 1024;
export const MAX_IMMUTABLE_PUT_ATTEMPTS = 3;
export const MAX_IMMUTABLE_UPLOAD_DURATION_MS = 5 * 60 * 1_000;
export const DEFAULT_IMMUTABLE_UPLOAD_DURATION_MS = 2 * 60 * 1_000;
/** Mirrors the durable backup catalogue's per-object safety ceiling. */
export const MAX_EXACT_OBJECT_READ_BYTES = 1024 * 1024 * 1024;

export type ObjectStorageLifecycleErrorCode =
  | "OBJECT_STORAGE_KEY_INVALID"
  | "OBJECT_STORAGE_UNCONFIGURED"
  | "OBJECT_STORAGE_LOCATOR_UNAVAILABLE"
  | "OBJECT_STORAGE_HEAD_UNSUPPORTED"
  | "OBJECT_STORAGE_METADATA_INVALID"
  | "OBJECT_STORAGE_LOCATOR_MISMATCH"
  | "OBJECT_STORAGE_VERSION_MISMATCH"
  | "OBJECT_STORAGE_DELETE_UNCONFIRMED"
  | "OBJECT_STORAGE_DELETE_ABORTED"
  | "OBJECT_STORAGE_DELETE_DEADLINE_EXCEEDED"
  | "OBJECT_STORAGE_UPLOAD_TOO_LARGE"
  | "OBJECT_STORAGE_IMMUTABLE_CONFLICT"
  | "OBJECT_STORAGE_IMMUTABLE_PUT_UNSUPPORTED"
  | "OBJECT_STORAGE_UPLOAD_FAILED"
  | "OBJECT_STORAGE_UPLOAD_UNCONFIRMED"
  | "OBJECT_STORAGE_UPLOAD_RETRY_EXHAUSTED"
  | "OBJECT_STORAGE_UPLOAD_ABORTED"
  | "OBJECT_STORAGE_UPLOAD_DEADLINE_EXCEEDED"
  | "OBJECT_STORAGE_READ_TOO_LARGE"
  | "OBJECT_STORAGE_READ_NOT_FOUND"
  | "OBJECT_STORAGE_READ_BODY_UNAVAILABLE"
  | "OBJECT_STORAGE_READ_ABORTED"
  | "OBJECT_STORAGE_READ_DEADLINE_EXCEEDED"
  | "OBJECT_STORAGE_READ_CANCELLED"
  | "OBJECT_STORAGE_READ_TRUNCATED"
  | "OBJECT_STORAGE_READ_OVERFLOW"
  | "OBJECT_STORAGE_READ_HASH_MISMATCH"
  | "OBJECT_STORAGE_READ_FAILED"
  | "OBJECT_STORAGE_FIELD_POINTER_INVALID"
  | "OBJECT_STORAGE_FIELD_UNAVAILABLE"
  | "OBJECT_STORAGE_FIELD_JSON_INVALID";

/** Static, key-free lifecycle failure safe to surface in structured logs. */
export class ObjectStorageLifecycleError extends Error {
  readonly code: ObjectStorageLifecycleErrorCode;

  constructor(code: ObjectStorageLifecycleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ObjectStorageLifecycleError";
    this.code = code;
  }
}

export interface ExactObjectStorageLocator {
  transport: ObjectStorageTransport;
  provider: ObjectStorageProvider;
  /** Stable configuration selector persisted by the owning catalogue. */
  endpointAlias: string;
  /** SHA-256 of stable, non-secret endpoint/account/binding authority. */
  backendIdentityFingerprint: string;
  bucket: string;
  region: string;
}

type RuntimeR2BucketWithHead = RuntimeR2Bucket & {
  head(key: string): Promise<RuntimeR2ObjectMetadata | null>;
};

export type ExactObjectStorageBackend =
  | {
      locator: ExactObjectStorageLocator;
      runtimeBucket: RuntimeR2BucketWithHead;
      s3Client?: never;
    }
  | {
      locator: ExactObjectStorageLocator;
      runtimeBucket?: never;
      s3Client: NonNullable<ReturnType<typeof getObjectStorageClient>>;
    };

type ResolvedLifecycleBackend = ExactObjectStorageBackend;

const IMMUTABLE_SHA256_METADATA_KEY = "eliza-content-sha256";

function runtimeBucketSupportsHead(bucket: RuntimeR2Bucket): bucket is RuntimeR2BucketWithHead {
  return typeof bucket.head === "function";
}

function requireExactBackendLocator(locator: ExactObjectStorageLocator): void {
  requireBucketName(locator.bucket);
  if (
    locator.endpointAlias.length === 0 ||
    locator.endpointAlias.trim() !== locator.endpointAlias ||
    locator.region.length === 0 ||
    locator.region.trim() !== locator.region ||
    !/^sha256:[0-9a-f]{64}$/.test(locator.backendIdentityFingerprint)
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Object lifecycle operations require canonical endpoint authority",
    );
  }
}

/** Build an explicit Worker R2 backend without consulting global bindings. */
export function createExactRuntimeR2Backend(input: {
  locator: ExactObjectStorageLocator;
  bucket: RuntimeR2Bucket;
}): ExactObjectStorageBackend {
  requireExactBackendLocator(input.locator);
  if (!runtimeBucketSupportsHead(input.bucket)) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_HEAD_UNSUPPORTED",
      "Registered Worker R2 binding does not expose HEAD",
    );
  }
  return { locator: Object.freeze({ ...input.locator }), runtimeBucket: input.bucket };
}

/** Build an explicit S3-compatible backend without consulting global env. */
export function createExactS3Backend(input: {
  locator: ExactObjectStorageLocator;
  client: NonNullable<ReturnType<typeof getObjectStorageClient>>;
}): ExactObjectStorageBackend {
  requireExactBackendLocator(input.locator);
  return { locator: Object.freeze({ ...input.locator }), s3Client: input.client };
}

function heavyPayloadBucket(): string | null {
  const env = getCloudAwareEnv();
  return (
    env.STORAGE_HEAVY_PAYLOADS_BUCKET ??
    env.STORAGE_BLOB_DEFAULT_BUCKET ??
    env.STORAGE_TRAJECTORIES_BUCKET ??
    env.R2_HEAVY_PAYLOADS_BUCKET ??
    env.R2_BLOB_DEFAULT_BUCKET ??
    env.R2_TRAJECTORIES_BUCKET ??
    null
  );
}

function storageConfigured(): boolean {
  if (runtimeR2BucketConfigured()) return true;
  return objectStorageConfigured() && Boolean(heavyPayloadBucket());
}

export function shouldUseObjectStorage(): boolean {
  const env = getCloudAwareEnv();
  const mode = env.SQL_HEAVY_PAYLOAD_STORAGE ?? env.HEAVY_PAYLOAD_STORAGE;
  if (mode === "inline") return false;
  if (mode === "r2") {
    if (!storageConfigured()) {
      throw new Error(
        "SQL_HEAVY_PAYLOAD_STORAGE=r2 but no Worker R2 binding or S3-compatible storage is configured",
      );
    }
    return true;
  }
  return storageConfigured();
}

/**
 * Hard ceiling on what a single field may persist inline in a SQL text or
 * jsonb column. Without it the offload helpers degrade into unbounded inline
 * writes whenever object storage is unconfigured, which is how quarter-gigabyte
 * failure dumps reached the `jobs.error` column (elizaOS/eliza#22553).
 */
const DEFAULT_MAX_INLINE_BYTES = 1024 * 1024;

function maxInlineBytes(): number {
  const raw = getCloudAwareEnv().SQL_HEAVY_PAYLOAD_MAX_INLINE_BYTES;
  if (!raw) return DEFAULT_MAX_INLINE_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1024) return DEFAULT_MAX_INLINE_BYTES;
  return Math.floor(parsed);
}

/** Raised when a payload exceeds the inline ceiling and cannot be offloaded. */
export class InlinePayloadTooLargeError extends Error {
  readonly code = "INLINE_PAYLOAD_TOO_LARGE";
  readonly field: string;
  readonly sizeBytes: number;
  readonly maxInlineBytes: number;

  constructor(input: { field: string; sizeBytes: number; maxBytes: number }) {
    super(
      `Inline payload for field "${input.field}" is ${input.sizeBytes} bytes, above the ` +
        `${input.maxBytes}-byte SQL inline ceiling, and object storage is not configured to ` +
        `offload it. Set SQL_HEAVY_PAYLOAD_STORAGE with a heavy-payload bucket, or persist a ` +
        `bounded summary instead of the full payload.`,
    );
    this.name = "InlinePayloadTooLargeError";
    this.field = input.field;
    this.sizeBytes = input.sizeBytes;
    this.maxInlineBytes = input.maxBytes;
  }
}

/** Byte size at which a value is refused inline storage. */
export function inlinePayloadCeilingBytes(): number {
  return maxInlineBytes();
}

export function assertInlinePayloadFits(field: string, value: string): void {
  const cap = maxInlineBytes();
  const size = byteLength(value);
  if (size > cap) {
    throw new InlinePayloadTooLargeError({ field, sizeBytes: size, maxBytes: cap });
  }
}

function minBytes(): number {
  const raw = getCloudAwareEnv().SQL_HEAVY_PAYLOAD_MIN_BYTES;
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function previewBytes(): number {
  const raw = getCloudAwareEnv().SQL_HEAVY_PAYLOAD_INLINE_PREVIEW_BYTES;
  if (!raw) return 512;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 512;
  return Math.floor(parsed);
}

function byteLength(value: string): number {
  // Count UTF-8 bytes without materializing a second payload-sized buffer.
  // These helpers run specifically on values large enough to threaten SQL;
  // TextEncoder.encode() would transiently duplicate a 250 MB dump before the
  // ceiling could reject or clamp it.
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      // BMP code points and unpaired surrogates encode to three bytes; the
      // latter matches TextEncoder's U+FFFD replacement behavior.
      bytes += 3;
    }
  }
  return bytes;
}

function shouldOffload(value: string): boolean {
  return value.length > 0 && shouldUseObjectStorage() && byteLength(value) >= minBytes();
}

function preview(value: string): string {
  const limit = previewBytes();
  if (limit === 0) return "";
  if (byteLength(value) <= limit) return value;
  let output = "";
  let size = 0;
  for (const char of value) {
    const charSize = byteLength(char);
    if (size + charSize > limit) break;
    output += char;
    size += charSize;
  }
  return output;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._=-]/g, "_");
}

/** Derive the immutable tenant/object/field key used by pointer-backed SQL rows. */
export function buildObjectFieldKey(params: {
  namespace: ObjectNamespace;
  organizationId: string;
  objectId: string;
  field: string;
  createdAt: Date;
  extension: "json" | "txt";
  /** Optional immutable write generation. Legacy callers omit it. */
  version?: string;
}): string {
  const day = params.createdAt.toISOString().slice(0, 10);
  const filename = params.version
    ? `${safeSegment(params.field)}.${safeSegment(params.version)}.${params.extension}`
    : `${safeSegment(params.field)}.${params.extension}`;
  return [
    params.namespace,
    safeSegment(params.organizationId),
    day,
    safeSegment(params.objectId),
    filename,
  ].join("/");
}

export async function putObjectText(params: {
  namespace: ObjectNamespace;
  organizationId: string;
  objectId: string;
  field: string;
  createdAt: Date;
  body: string;
  contentType: string;
  version?: string;
  /** Create-only write. Required for versioned SQL pointers. */
  immutable?: boolean;
}): Promise<string> {
  const extension = params.contentType.includes("json") ? "json" : "txt";
  const key = buildObjectFieldKey({ ...params, extension });

  const runtimeBucket = getRuntimeR2Bucket();
  if (runtimeBucket) {
    const result = await runtimeBucket.put(key, params.body, {
      ...(params.immutable ? { onlyIf: new Headers({ "if-none-match": "*" }) } : {}),
      httpMetadata: { contentType: params.contentType },
    });
    if (params.immutable && result === null) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_IMMUTABLE_CONFLICT",
        "Immutable field object already exists",
      );
    }
    return key;
  }

  const bucket = heavyPayloadBucket();
  const client = getObjectStorageClient();
  if (!bucket || !client) {
    throw new Error("Object storage requested but client or bucket is not configured");
  }

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: params.body,
        ContentType: params.contentType,
        ...(params.immutable ? { IfNoneMatch: "*" } : {}),
      }),
    );
  } catch (error) {
    // error-policy:J1 translate only the create-only conflict; all other
    // provider failures retain their original authority for existing callers.
    if (params.immutable && classifyImmutableWriteFailure(error) === "precondition") {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_IMMUTABLE_CONFLICT",
        "Immutable field object already exists",
      );
    }
    throw error;
  }
  return key;
}

export async function getObjectText(key: string): Promise<string | null> {
  const runtimeBucket = getRuntimeR2Bucket();
  if (runtimeBucket) {
    const object = await runtimeBucket.get(key);
    return object ? await object.text() : null;
  }

  const bucket = heavyPayloadBucket();
  const client = getObjectStorageClient();
  if (!bucket || !client) return null;
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await out.Body?.transformToString()) ?? null;
}

function requireExactKey(key: string): void {
  if (typeof key !== "string" || key.length === 0 || key.includes("\0") || byteLength(key) > 1024) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_KEY_INVALID",
      "Object lifecycle operations require a valid non-empty exact key",
    );
  }
}

function requireBucketName(bucket: string | null): string {
  if (!bucket || bucket.trim() !== bucket) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Object lifecycle operations require an explicit canonical bucket name",
    );
  }
  return bucket;
}

async function fingerprintKey(key: string): Promise<string> {
  return `sha256:${await sha256Hex(key)}`;
}

async function legacyBackendIdentityFingerprint(input: {
  transport: ObjectStorageTransport;
  provider: ObjectStorageProvider;
  bucket: string;
  region: string;
}): Promise<string> {
  const identity = JSON.stringify({
    version: 1,
    ...input,
    endpoint: process.env.STORAGE_ENDPOINT?.trim() ?? null,
    accountId: process.env.R2_ACCOUNT_ID?.trim() ?? null,
  });
  return fingerprintKey(identity);
}

function checksumBytesToBase64(value: ArrayBuffer): string {
  // Pure byte encoder: works in both Workers and Node without depending on
  // Node's Buffer or the presence of a browser `btoa` global.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(value);
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    output += alphabet.charAt(first >> 2);
    output += alphabet.charAt(((first & 0x03) << 4) | (second >> 4));
    output +=
      index + 1 < bytes.length ? alphabet.charAt(((second & 0x0f) << 2) | (third >> 6)) : "=";
    output += index + 2 < bytes.length ? alphabet.charAt(third & 0x3f) : "=";
  }
  return output;
}

function normalizedEtag(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizedSha256(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  // SHA-256 is exactly 32 bytes and canonical base64 is exactly 44 chars.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) return null;
  return trimmed;
}

function requireObjectSize(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      "Object storage HEAD returned an invalid object size",
    );
  }
  return value;
}

function runtimeChecksum(
  object: RuntimeR2ObjectMetadata,
  requireProviderValidated = false,
): ObjectChecksumReceipt {
  if (object.checksums?.sha256) {
    return {
      algorithm: "sha256",
      encoding: "base64",
      value: checksumBytesToBase64(object.checksums.sha256),
    };
  }
  if (!requireProviderValidated) {
    const declaredSha256 = normalizedSha256(object.customMetadata?.[IMMUTABLE_SHA256_METADATA_KEY]);
    if (declaredSha256) {
      return { algorithm: "sha256", encoding: "base64", value: declaredSha256 };
    }
  }
  if (object.checksums?.sha1) {
    return {
      algorithm: "sha1",
      encoding: "base64",
      value: checksumBytesToBase64(object.checksums.sha1),
    };
  }
  if (object.checksums?.md5) {
    return {
      algorithm: "md5",
      encoding: "base64",
      value: checksumBytesToBase64(object.checksums.md5),
    };
  }
  const etag = normalizedEtag(object.etag);
  if (etag) return { algorithm: "etag", encoding: "opaque", value: etag };
  throw new ObjectStorageLifecycleError(
    "OBJECT_STORAGE_METADATA_INVALID",
    "Object storage HEAD returned no integrity identifier",
  );
}

function s3Checksum(
  object: HeadObjectCommandOutput,
  requireProviderValidated = false,
): ObjectChecksumReceipt {
  if (object.ChecksumSHA256) {
    return { algorithm: "sha256", encoding: "base64", value: object.ChecksumSHA256 };
  }
  if (!requireProviderValidated) {
    const declaredSha256 = normalizedSha256(object.Metadata?.[IMMUTABLE_SHA256_METADATA_KEY]);
    if (declaredSha256) {
      return { algorithm: "sha256", encoding: "base64", value: declaredSha256 };
    }
  }
  if (object.ChecksumSHA1) {
    return { algorithm: "sha1", encoding: "base64", value: object.ChecksumSHA1 };
  }
  const etag = normalizedEtag(object.ETag);
  if (etag) return { algorithm: "etag", encoding: "opaque", value: etag };
  throw new ObjectStorageLifecycleError(
    "OBJECT_STORAGE_METADATA_INVALID",
    "Object storage HEAD returned no integrity identifier",
  );
}

function objectVersion(params: {
  providerVersion?: string;
  etag?: string;
  checksum: ObjectChecksumReceipt;
}): Pick<ObjectLocatorReceipt, "version" | "versionSource"> {
  const providerVersion = params.providerVersion?.trim();
  if (providerVersion) return { version: providerVersion, versionSource: "provider" };
  const etag = normalizedEtag(params.etag);
  if (etag) return { version: etag, versionSource: "etag" };
  return { version: params.checksum.value, versionSource: "checksum" };
}

function makeLocator(
  backend: ResolvedLifecycleBackend,
  keyFingerprint: string,
  version: Pick<ObjectLocatorReceipt, "version" | "versionSource"> = {
    version: null,
    versionSource: "none",
  },
): ObjectLocatorReceipt {
  return new ObjectLocatorReceipt({ ...backend.locator, keyFingerprint, ...version });
}

async function resolveLifecycleBackend(options?: {
  singleAttemptS3?: boolean;
}): Promise<ResolvedLifecycleBackend> {
  const runtimeBucket = getRuntimeR2Bucket();
  const bucket = requireBucketName(heavyPayloadBucket());
  if (runtimeBucket) {
    if (!runtimeBucketSupportsHead(runtimeBucket)) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_HEAD_UNSUPPORTED",
        "Registered Worker R2 binding does not expose HEAD",
      );
    }
    const locator = {
      transport: "worker-r2-binding" as const,
      provider: "r2" as const,
      endpointAlias: "legacy-heavy-payloads",
      backendIdentityFingerprint: await legacyBackendIdentityFingerprint({
        transport: "worker-r2-binding",
        provider: "r2",
        bucket,
        region: "auto",
      }),
      bucket,
      region: "auto",
    };
    return {
      locator,
      runtimeBucket,
    };
  }

  const provider = getObjectStorageProvider();
  const s3Client = options?.singleAttemptS3
    ? getSingleAttemptObjectStorageClient()
    : getObjectStorageClient();
  if (!provider || !s3Client) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_UNCONFIGURED",
      "Object lifecycle operation requested without a configured storage backend",
    );
  }
  const region = await s3Client.config.region();
  if (!region) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Object lifecycle operations require an explicit storage region",
    );
  }
  const locator = {
    transport: "s3-compatible" as const,
    provider,
    endpointAlias: "legacy-heavy-payloads",
    backendIdentityFingerprint: await legacyBackendIdentityFingerprint({
      transport: "s3-compatible",
      provider,
      bucket,
      region,
    }),
    bucket,
    region,
  };
  return {
    locator,
    s3Client,
  };
}

function isS3ObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const shaped = error as {
    name?: unknown;
    code?: unknown;
    Code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  if (shaped.$metadata?.httpStatusCode !== 404) return false;
  const providerCode = shaped.name ?? shaped.code ?? shaped.Code;
  return (
    providerCode === "NotFound" ||
    providerCode === "NoSuchKey" ||
    providerCode === "NoSuchVersion" ||
    providerCode === "404"
  );
}

async function headObjectOnBackend(
  backend: ResolvedLifecycleBackend,
  key: string,
  keyFingerprint: string,
  requestChecksum = false,
  providerVersionId?: string,
  control?: ProviderRequestAbortContext,
): Promise<ObjectHeadReceipt> {
  if (backend.runtimeBucket) {
    const request = backend.runtimeBucket.head(key);
    const object = control ? await control.race(request) : await request;
    if (!object) {
      return {
        status: "absent",
        locator: makeLocator(backend, keyFingerprint),
        metadata: null,
      };
    }
    const checksum = runtimeChecksum(object, requestChecksum);
    return {
      status: "present",
      locator: makeLocator(
        backend,
        keyFingerprint,
        objectVersion({ providerVersion: object.version, etag: object.etag, checksum }),
      ),
      metadata: { sizeBytes: requireObjectSize(object.size), checksum },
    };
  }

  try {
    const request = backend.s3Client.send(
      new HeadObjectCommand({
        Bucket: backend.locator.bucket,
        Key: key,
        VersionId: providerVersionId,
        ChecksumMode: requestChecksum ? "ENABLED" : undefined,
      }),
      control ? { abortSignal: control.signal } : undefined,
    );
    const object = control ? await control.race(request) : await request;
    const checksum = s3Checksum(object, requestChecksum);
    return {
      status: "present",
      locator: makeLocator(
        backend,
        keyFingerprint,
        objectVersion({ providerVersion: object.VersionId, etag: object.ETag, checksum }),
      ),
      metadata: { sizeBytes: requireObjectSize(object.ContentLength), checksum },
    };
  } catch (error) {
    if (control?.signal.aborted) throw control.failure();
    // error-policy:J1 translate only the provider's authoritative not-found
    // response into the explicit absent result at the object-store boundary.
    if (!isS3ObjectNotFound(error)) throw error;
    return {
      status: "absent",
      locator: makeLocator(backend, keyFingerprint),
      metadata: null,
    };
  }
}

function locatorScopeMatches(
  expected: ObjectLocatorReceipt,
  actual: ObjectLocatorReceipt,
): boolean {
  return (
    expected.transport === actual.transport &&
    expected.provider === actual.provider &&
    expected.endpointAlias === actual.endpointAlias &&
    expected.backendIdentityFingerprint === actual.backendIdentityFingerprint &&
    expected.bucket === actual.bucket &&
    expected.region === actual.region &&
    expected.keyFingerprint === actual.keyFingerprint
  );
}

interface ExactReadAbortContext {
  readonly signal: AbortSignal;
  ensureActive(): void;
  failure(): ObjectStorageLifecycleError;
  dispose(): void;
}

function createExactReadAbortContext(input: GetExactObjectInput): ExactReadAbortContext {
  const deadlineAt = input.deadline?.getTime() ?? null;
  if (deadlineAt !== null && !Number.isFinite(deadlineAt)) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      "Exact object read requires a valid absolute deadline",
    );
  }

  const controller = new AbortController();
  let source: "caller" | "deadline" | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const abort = (nextSource: "caller" | "deadline") => {
    if (source !== null || disposed) return;
    source = nextSource;
    controller.abort();
  };
  const onCallerAbort = () => abort("caller");
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (input.signal?.aborted) abort("caller");

  const armDeadline = () => {
    if (deadlineAt === null || source !== null || disposed) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      abort("deadline");
      return;
    }
    // Node timers clamp larger values. Re-arm rather than firing early.
    timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
  };
  armDeadline();

  const failure = () =>
    source === "deadline"
      ? new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_READ_DEADLINE_EXCEEDED",
          "Exact object read exceeded its deadline",
        )
      : new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_READ_ABORTED",
          "Exact object read was aborted",
        );

  return {
    signal: controller.signal,
    ensureActive() {
      if (deadlineAt !== null && Date.now() >= deadlineAt) abort("deadline");
      if (input.signal?.aborted) abort("caller");
      if (controller.signal.aborted) throw failure();
    },
    failure,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      input.signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function requireExactReadExpectation(input: GetExactObjectInput): Sha256ChecksumReceipt {
  if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      "Exact object read requires a valid expected byte length",
    );
  }
  if (input.expectedSize > MAX_EXACT_OBJECT_READ_BYTES) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_READ_TOO_LARGE",
      "Exact object read exceeds the bounded streaming limit",
    );
  }
  if (
    typeof input.expectedCipherSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.expectedCipherSha256)
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      "Exact object read requires a canonical ciphertext SHA-256",
    );
  }
  const digest = new Uint8Array(32);
  for (let index = 0; index < digest.length; index += 1) {
    digest[index] = Number.parseInt(input.expectedCipherSha256.slice(index * 2, index * 2 + 2), 16);
  }
  return {
    algorithm: "sha256",
    encoding: "base64",
    value: checksumBytesToBase64(digest.buffer),
  };
}

function requireExactReadVersion(locator: ObjectLocatorReceipt): void {
  if (
    (locator.versionSource !== "provider" &&
      locator.versionSource !== "etag" &&
      locator.versionSource !== "checksum") ||
    typeof locator.version !== "string" ||
    locator.version.length === 0 ||
    locator.version.length > 1024 ||
    locator.version.includes("\0") ||
    (locator.versionSource === "etag" && /["\r\n]/.test(locator.version))
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Exact object read requires a persisted provider generation",
    );
  }
}

function assertExactReadHeaders(input: {
  expectedLocator: ObjectLocatorReceipt;
  observedLocator: ObjectLocatorReceipt;
  observedMetadata: ObjectMetadataReceipt;
  expectedSize: number;
  expectedChecksum: Sha256ChecksumReceipt;
}): ObjectMetadataReceipt & { checksum: Sha256ChecksumReceipt } {
  if (
    input.observedLocator.version !== input.expectedLocator.version ||
    input.observedLocator.versionSource !== input.expectedLocator.versionSource
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_VERSION_MISMATCH",
      "Exact object read refused because the provider generation changed",
    );
  }
  if (
    input.observedMetadata.sizeBytes !== input.expectedSize ||
    input.observedMetadata.checksum.algorithm !== "sha256" ||
    input.observedMetadata.checksum.encoding !== "base64" ||
    input.observedMetadata.checksum.value !== input.expectedChecksum.value
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      "Exact object read headers do not match the encrypted catalogue object",
    );
  }
  return Object.freeze({
    sizeBytes: input.observedMetadata.sizeBytes,
    checksum: Object.freeze({
      algorithm: "sha256" as const,
      encoding: "base64" as const,
      value: input.observedMetadata.checksum.value,
    }),
  });
}

function runtimeGetMetadata(object: RuntimeR2ObjectMetadata & { size?: number }): {
  locatorVersion: Pick<ObjectLocatorReceipt, "version" | "versionSource">;
  metadata: ObjectMetadataReceipt;
} {
  if (typeof object.etag !== "string" || object.etag.trim().length === 0) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      "Worker R2 GET returned incomplete object metadata",
    );
  }
  const checksum = runtimeChecksum(object);
  return {
    locatorVersion: objectVersion({
      providerVersion: object.version,
      etag: object.etag,
      checksum,
    }),
    metadata: { sizeBytes: requireObjectSize(object.size), checksum },
  };
}

function s3GetMetadata(object: GetObjectCommandOutput): {
  locatorVersion: Pick<ObjectLocatorReceipt, "version" | "versionSource">;
  metadata: ObjectMetadataReceipt;
} {
  const checksum = s3Checksum(object);
  return {
    locatorVersion: objectVersion({
      providerVersion: object.VersionId,
      etag: object.ETag,
      checksum,
    }),
    metadata: { sizeBytes: requireObjectSize(object.ContentLength), checksum },
  };
}

function isReadableByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    "getReader" in value &&
    typeof value.getReader === "function"
  );
}

function s3ResponseBodyStream(body: GetObjectCommandOutput["Body"]): ReadableStream<Uint8Array> {
  if (isReadableByteStream(body)) return body;
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToWebStream" in body &&
    typeof body.transformToWebStream === "function"
  ) {
    const stream = body.transformToWebStream();
    if (isReadableByteStream(stream)) return stream;
  }
  throw new ObjectStorageLifecycleError(
    "OBJECT_STORAGE_READ_BODY_UNAVAILABLE",
    "S3-compatible GET did not expose a streaming response body",
  );
}

async function cancelUntransferredBody(
  body: unknown,
  context: ExactReadAbortContext,
): Promise<void> {
  try {
    if (isReadableByteStream(body)) {
      await raceRuntimeGet(Promise.resolve(body.cancel()), context);
      return;
    }
    if (
      typeof body === "object" &&
      body !== null &&
      "destroy" in body &&
      typeof body.destroy === "function"
    ) {
      body.destroy();
      return;
    }
    if (
      typeof body === "object" &&
      body !== null &&
      "transformToWebStream" in body &&
      typeof body.transformToWebStream === "function"
    ) {
      const stream = body.transformToWebStream();
      if (isReadableByteStream(stream)) {
        await raceRuntimeGet(Promise.resolve(stream.cancel()), context);
      }
    }
  } catch {
    // error-policy:J6 best-effort teardown must not replace the static
    // storage-domain error.
  }
}

function providerReadFailure(
  error: unknown,
  context: ExactReadAbortContext,
): ObjectStorageLifecycleError {
  if (error instanceof ObjectStorageLifecycleError) return error;
  if (context.signal.aborted) return context.failure();
  if (isS3ObjectNotFound(error)) {
    return new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_READ_NOT_FOUND",
      "Exact object read could not find the catalogued object",
    );
  }
  if (providerHttpStatus(error) === 412 || providerErrorCode(error) === "PreconditionFailed") {
    return new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_VERSION_MISMATCH",
      "Exact object read refused because the provider generation changed",
    );
  }
  return new ObjectStorageLifecycleError(
    "OBJECT_STORAGE_READ_FAILED",
    "Exact object read failed at the storage provider boundary",
  );
}

async function raceRuntimeGet<T>(request: Promise<T>, context: ExactReadAbortContext): Promise<T> {
  context.ensureActive();
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(context.failure());
    context.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([request, aborted]);
  } finally {
    if (onAbort) context.signal.removeEventListener("abort", onAbort);
  }
}

function createVerifiedExactRead(input: {
  providerBody: ReadableStream<Uint8Array>;
  observedLocator: ObjectLocatorReceipt;
  declaredMetadata: ObjectMetadataReceipt & { checksum: Sha256ChecksumReceipt };
  expectedCipherSha256: string;
  context: ExactReadAbortContext;
}): ExactObjectRead {
  const providerReader = input.providerBody.getReader();
  const hasher = createHash("sha256");
  let receivedBytes = 0;
  let settled = false;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let resolveCompletion!: (receipt: ExactObjectReadReceipt) => void;
  let rejectCompletion!: (error: ObjectStorageLifecycleError) => void;
  const completion = new Promise<ExactObjectReadReceipt>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // error-policy:J5 the contract requires callers to await completion, but
  // attach an observer so an abandoned caller cannot create an unhandled
  // rejection. The same rejection remains observable through `completion`.
  void completion.catch(() => undefined);

  const cleanup = () => {
    input.context.signal.removeEventListener("abort", onAbort);
    input.context.dispose();
  };
  let providerCancellation: Promise<void> | null = null;
  const cancelProvider = (): Promise<void> => {
    if (!providerCancellation) {
      try {
        providerCancellation = providerReader.cancel().then(
          () => undefined,
          () => undefined,
        );
      } catch {
        // error-policy:J6 cancellation is best-effort after the read has
        // already failed or been abandoned.
        providerCancellation = Promise.resolve();
      }
    }
    return providerCancellation;
  };
  const fail = (error: unknown): Promise<void> => {
    if (settled) return providerCancellation ?? Promise.resolve();
    settled = true;
    const translated = providerReadFailure(error, input.context);
    cleanup();
    rejectCompletion(translated);
    try {
      streamController?.error(translated);
    } catch {
      // error-policy:J6 the public stream may already be in its cancelled
      // state; the completion promise retains the authoritative failure.
    }
    return cancelProvider();
  };
  const onAbort = () => {
    void fail(input.context.failure());
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      input.context.signal.addEventListener("abort", onAbort, { once: true });
      if (input.context.signal.aborted) onAbort();
    },
    async pull(controller) {
      if (settled) return;
      try {
        input.context.ensureActive();
        const next = await providerReader.read();
        input.context.ensureActive();
        if (next.done) {
          if (receivedBytes !== input.declaredMetadata.sizeBytes) {
            throw new ObjectStorageLifecycleError(
              "OBJECT_STORAGE_READ_TRUNCATED",
              "Exact object read ended before the declared byte length",
            );
          }
          const actualCipherSha256 = hasher.digest("hex");
          if (actualCipherSha256 !== input.expectedCipherSha256) {
            throw new ObjectStorageLifecycleError(
              "OBJECT_STORAGE_READ_HASH_MISMATCH",
              "Exact object read failed ciphertext integrity verification",
            );
          }
          settled = true;
          cleanup();
          const receipt: ExactObjectReadReceipt = Object.freeze({
            locator: input.observedLocator,
            metadata: input.declaredMetadata,
            verifiedComplete: true,
          });
          resolveCompletion(receipt);
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)) {
          throw new ObjectStorageLifecycleError(
            "OBJECT_STORAGE_READ_FAILED",
            "Exact object read received a non-byte provider chunk",
          );
        }
        if (receivedBytes + next.value.byteLength > input.declaredMetadata.sizeBytes) {
          throw new ObjectStorageLifecycleError(
            "OBJECT_STORAGE_READ_OVERFLOW",
            "Exact object read exceeded the declared byte length",
          );
        }
        receivedBytes += next.value.byteLength;
        hasher.update(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        // error-policy:J1 the ReadableStream boundary publishes the translated
        // failure through both the stream and its completion promise.
        await fail(error);
      }
    },
    cancel() {
      if (settled) return providerCancellation ?? undefined;
      return fail(
        new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_READ_CANCELLED",
          "Exact object read was cancelled before verification completed",
        ),
      );
    },
  });

  return Object.freeze({
    body,
    declaredMetadata: input.declaredMetadata,
    completion,
  });
}

function snapshotExactReadBackend(backend: ExactObjectStorageBackend): ExactObjectStorageBackend {
  const locator = Object.freeze({ ...backend.locator });
  if (backend.runtimeBucket) {
    return Object.freeze({ locator, runtimeBucket: backend.runtimeBucket });
  }
  return Object.freeze({ locator, s3Client: backend.s3Client });
}

async function getExactObjectOnBackend(
  backend: ExactObjectStorageBackend,
  input: GetExactObjectInput,
): Promise<ExactObjectRead> {
  const inputLocator = input.locator;
  const request: GetExactObjectInput = Object.freeze({
    locator: Object.freeze({
      key: inputLocator.key,
      receipt: new ObjectLocatorReceipt({
        transport: inputLocator.receipt.transport,
        provider: inputLocator.receipt.provider,
        endpointAlias: inputLocator.receipt.endpointAlias,
        backendIdentityFingerprint: inputLocator.receipt.backendIdentityFingerprint,
        bucket: inputLocator.receipt.bucket,
        region: inputLocator.receipt.region,
        keyFingerprint: inputLocator.receipt.keyFingerprint,
        version: inputLocator.receipt.version,
        versionSource: inputLocator.receipt.versionSource,
      }),
    }),
    expectedSize: input.expectedSize,
    expectedCipherSha256: input.expectedCipherSha256,
    signal: input.signal,
    deadline:
      input.deadline === undefined
        ? undefined
        : input.deadline instanceof Date
          ? new Date(input.deadline.getTime())
          : new Date(Number.NaN),
  });
  const exactBackend = snapshotExactReadBackend(backend);
  requireExactKey(request.locator.key);
  requireExactBackendLocator(exactBackend.locator);
  requireExactReadVersion(request.locator.receipt);
  const expectedChecksum = requireExactReadExpectation(request);
  const context = createExactReadAbortContext(request);

  try {
    context.ensureActive();
    const keyFingerprint = await fingerprintKey(request.locator.key);
    context.ensureActive();
    const currentScope = makeLocator(exactBackend, keyFingerprint);
    if (!locatorScopeMatches(request.locator.receipt, currentScope)) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_LOCATOR_MISMATCH",
        "Exact object read locator no longer matches the configured backend",
      );
    }

    if (exactBackend.runtimeBucket) {
      const providerRequest = exactBackend.runtimeBucket.get(
        request.locator.key,
        request.locator.receipt.versionSource === "etag"
          ? { onlyIf: { etagMatches: request.locator.receipt.version ?? undefined } }
          : undefined,
      );
      let object: Awaited<typeof providerRequest>;
      try {
        object = await raceRuntimeGet(providerRequest, context);
      } catch (error) {
        if (context.signal.aborted) {
          // error-policy:J5 the raced request is still observed and a late
          // response body is cancelled; the abort remains authoritative.
          void providerRequest
            .then((lateObject) => lateObject?.body?.cancel())
            .catch(() => undefined);
        }
        throw error;
      }
      if (!object) {
        throw new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_READ_NOT_FOUND",
          "Exact object read could not find the catalogued object",
        );
      }
      let bodyTransferred = false;
      try {
        const observed = runtimeGetMetadata(object as RuntimeR2ObjectMetadata);
        const observedLocator = makeLocator(exactBackend, keyFingerprint, observed.locatorVersion);
        const declaredMetadata = assertExactReadHeaders({
          expectedLocator: request.locator.receipt,
          observedLocator,
          observedMetadata: observed.metadata,
          expectedSize: request.expectedSize,
          expectedChecksum,
        });
        if (!isReadableByteStream(object.body)) {
          throw new ObjectStorageLifecycleError(
            "OBJECT_STORAGE_READ_BODY_UNAVAILABLE",
            "Worker R2 GET did not expose a streaming response body",
          );
        }
        const read = createVerifiedExactRead({
          providerBody: object.body,
          observedLocator,
          declaredMetadata,
          expectedCipherSha256: request.expectedCipherSha256,
          context,
        });
        bodyTransferred = true;
        return read;
      } finally {
        if (!bodyTransferred) await cancelUntransferredBody(object.body, context);
      }
    }

    const object = await exactBackend.s3Client.send(
      new GetObjectCommand({
        Bucket: exactBackend.locator.bucket,
        Key: request.locator.key,
        VersionId:
          request.locator.receipt.versionSource === "provider"
            ? (request.locator.receipt.version ?? undefined)
            : undefined,
        IfMatch:
          request.locator.receipt.versionSource === "etag"
            ? `"${request.locator.receipt.version}"`
            : undefined,
      }),
      { abortSignal: context.signal },
    );
    let bodyTransferred = false;
    try {
      context.ensureActive();
      const observed = s3GetMetadata(object);
      const observedLocator = makeLocator(exactBackend, keyFingerprint, observed.locatorVersion);
      const providerBody = s3ResponseBodyStream(object.Body);
      const declaredMetadata = assertExactReadHeaders({
        expectedLocator: request.locator.receipt,
        observedLocator,
        observedMetadata: observed.metadata,
        expectedSize: request.expectedSize,
        expectedChecksum,
      });
      const read = createVerifiedExactRead({
        providerBody,
        observedLocator,
        declaredMetadata,
        expectedCipherSha256: request.expectedCipherSha256,
        context,
      });
      bodyTransferred = true;
      return read;
    } finally {
      if (!bodyTransferred) await cancelUntransferredBody(object.Body, context);
    }
  } catch (error) {
    // error-policy:J2 add stable storage-domain context while preserving cause.
    context.dispose();
    throw providerReadFailure(error, context);
  }
}

/** GET one exact object generation on a caller-resolved backend. */
export async function getExactObjectAtBackend(params: {
  backend: ExactObjectStorageBackend;
  input: GetExactObjectInput;
}): Promise<ExactObjectRead> {
  return getExactObjectOnBackend(params.backend, params.input);
}

interface ProviderRequestAbortContext {
  readonly signal: AbortSignal;
  ensureActive(): void;
  failure(): ObjectStorageLifecycleError;
  race<T>(request: Promise<T>): Promise<T>;
  wait(delayMs: number): Promise<void>;
  dispose(): void;
}

function createProviderRequestAbortContext(
  input: ObjectRequestControl,
  policy: Readonly<{
    operation: string;
    deadlineCode: ObjectStorageLifecycleErrorCode;
    abortCode: ObjectStorageLifecycleErrorCode;
  }> = {
    operation: "Immutable object upload",
    deadlineCode: "OBJECT_STORAGE_UPLOAD_DEADLINE_EXCEEDED",
    abortCode: "OBJECT_STORAGE_UPLOAD_ABORTED",
  },
): ProviderRequestAbortContext {
  const now = Date.now();
  const suppliedDeadline = input.deadline?.getTime();
  if (suppliedDeadline !== undefined && !Number.isFinite(suppliedDeadline)) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      `${policy.operation} requires a valid absolute deadline`,
    );
  }
  const deadlineAt = suppliedDeadline ?? now + DEFAULT_IMMUTABLE_UPLOAD_DURATION_MS;
  if (deadlineAt - now > MAX_IMMUTABLE_UPLOAD_DURATION_MS) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      `${policy.operation} deadline exceeds the bounded provider-I/O window`,
    );
  }

  const controller = new AbortController();
  let source: "caller" | "deadline" | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const abort = (nextSource: "caller" | "deadline") => {
    if (source !== null || disposed) return;
    source = nextSource;
    controller.abort();
  };
  const onCallerAbort = () => abort("caller");
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (input.signal?.aborted) abort("caller");

  const armDeadline = () => {
    if (source !== null || disposed) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      abort("deadline");
      return;
    }
    deadlineTimer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
  };
  armDeadline();

  const failure = () =>
    source === "deadline"
      ? new ObjectStorageLifecycleError(
          policy.deadlineCode,
          `${policy.operation} provider I/O exceeded its deadline`,
        )
      : new ObjectStorageLifecycleError(
          policy.abortCode,
          `${policy.operation} provider I/O was aborted`,
        );

  const ensureActive = () => {
    if (Date.now() >= deadlineAt) abort("deadline");
    if (input.signal?.aborted) abort("caller");
    if (controller.signal.aborted) throw failure();
  };

  const race = async <T>(request: Promise<T>): Promise<T> => {
    ensureActive();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(failure());
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([request, aborted]);
    } finally {
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  };

  return {
    signal: controller.signal,
    ensureActive,
    failure,
    race,
    async wait(delayMs: number) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await race(
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, delayMs);
          }),
        );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      input.signal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

/** HEAD one exact key without downloading its body. */
export async function headObject(
  key: string,
  control: ObjectRequestControl = {},
): Promise<ObjectHeadReceipt> {
  requireExactKey(key);
  const context = createProviderRequestAbortContext(control);
  try {
    const [backend, keyFingerprint] = await context.race(
      Promise.all([resolveLifecycleBackend(), fingerprintKey(key)]),
    );
    return await headObjectOnBackend(backend, key, keyFingerprint, false, undefined, context);
  } finally {
    context.dispose();
  }
}

/** HEAD one exact key on a caller-resolved backend. */
export async function headObjectAtBackend(
  backend: ExactObjectStorageBackend,
  key: string,
  control: ObjectRequestControl = {},
): Promise<ObjectHeadReceipt> {
  requireExactKey(key);
  requireExactBackendLocator(backend.locator);
  const context = createProviderRequestAbortContext(control);
  try {
    const keyFingerprint = await context.race(fingerprintKey(key));
    return await headObjectOnBackend(backend, key, keyFingerprint, false, undefined, context);
  } finally {
    context.dispose();
  }
}

type ImmutableWriteFailure = "none" | "precondition" | "retryable" | "unsupported" | "fatal";

function providerHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const shaped = error as {
    status?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const candidate = shaped.$metadata?.httpStatusCode ?? shaped.statusCode ?? shaped.status ?? null;
  return typeof candidate === "number" && Number.isInteger(candidate) ? candidate : null;
}

function providerErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const shaped = error as { name?: unknown; code?: unknown; Code?: unknown };
  const candidate = shaped.name ?? shaped.code ?? shaped.Code;
  return typeof candidate === "string" ? candidate : null;
}

function isRetryableProviderError(error: unknown): boolean {
  const status = providerHttpStatus(error);
  if (status !== null) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }
  const code = providerErrorCode(error);
  return (
    error instanceof TypeError ||
    code === "AbortError" ||
    code === "TimeoutError" ||
    code === "RequestTimeout" ||
    code === "NetworkingError" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT"
  );
}

function classifyImmutableWriteFailure(error: unknown): ImmutableWriteFailure {
  const status = providerHttpStatus(error);
  const code = providerErrorCode(error);
  if (status === 412 || code === "PreconditionFailed") return "precondition";
  if (
    status === 405 ||
    status === 501 ||
    code === "NotImplemented" ||
    code === "NotSupported" ||
    code === "UnsupportedOperation"
  ) {
    return "unsupported";
  }
  return isRetryableProviderError(error) ? "retryable" : "fatal";
}

function immutableUploadBytes(
  body: ArrayBuffer | Uint8Array,
  transferBodyOwnership: boolean,
): Uint8Array<ArrayBuffer> {
  if (transferBodyOwnership) {
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (body.buffer instanceof ArrayBuffer) {
      return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    }
  }
  const copy = new Uint8Array(body.byteLength);
  copy.set(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
  return copy;
}

async function immutableSha256(body: Uint8Array<ArrayBuffer>): Promise<{
  bytes: ArrayBuffer;
  receipt: Sha256ChecksumReceipt;
}> {
  const digest = await sha256Bytes(body);
  return {
    bytes: digest.buffer,
    receipt: {
      algorithm: "sha256",
      encoding: "base64",
      value: checksumBytesToBase64(digest.buffer),
    },
  };
}

function immutableReceiptFromHead(
  observed: ObjectHeadReceipt,
  expected: ImmutableObjectUploadReceipt["metadata"],
): ImmutableObjectUploadReceipt | null {
  if (observed.status === "absent") return null;
  if (
    observed.metadata.sizeBytes !== expected.sizeBytes ||
    observed.metadata.checksum.algorithm !== "sha256" ||
    observed.metadata.checksum.encoding !== "base64" ||
    observed.metadata.checksum.value !== expected.checksum.value
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_IMMUTABLE_CONFLICT",
      "Immutable object upload refused because the exact key already has different content",
    );
  }
  return {
    locator: observed.locator,
    metadata: {
      sizeBytes: observed.metadata.sizeBytes,
      checksum: {
        algorithm: "sha256",
        encoding: "base64",
        value: observed.metadata.checksum.value,
      },
    },
    verifiedPresent: true,
  };
}

async function immutableRetryBackoff(
  attempt: number,
  context: ProviderRequestAbortContext,
): Promise<void> {
  const delayMs = 25 * 2 ** Math.max(0, attempt - 1);
  await context.wait(delayMs);
}

/**
 * Put one bounded object under an immutable exact key.
 *
 * Both transports use a provider-side create-only precondition. Every result,
 * including a retry after an ambiguous/lost response, is reconstructed from a
 * strongly-consistent HEAD and must match both SHA-256 and byte length. The
 * returned receipt deliberately excludes the complete object key.
 */
async function putImmutableObjectOnBackend(params: {
  backend: ExactObjectStorageBackend;
  key: PutImmutableObjectInput["key"];
  body: PutImmutableObjectInput["body"];
  contentType?: PutImmutableObjectInput["contentType"];
  signal?: PutImmutableObjectInput["signal"];
  deadline?: PutImmutableObjectInput["deadline"];
  beforeWriteAttempt?: PutImmutableObjectInput["beforeWriteAttempt"];
  transferBodyOwnership?: PutImmutableObjectInput["transferBodyOwnership"];
}): Promise<ImmutableObjectUploadReceipt> {
  requireExactKey(params.key);
  requireExactBackendLocator(params.backend.locator);
  if (params.body.byteLength > MAX_IMMUTABLE_SINGLE_PUT_BYTES) {
    if (params.transferBodyOwnership) {
      (params.body instanceof ArrayBuffer ? new Uint8Array(params.body) : params.body).fill(0);
    }
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_UPLOAD_TOO_LARGE",
      "Immutable single-PUT object exceeds the bounded upload limit",
    );
  }
  const body = immutableUploadBytes(params.body, params.transferBodyOwnership === true);
  let context: ProviderRequestAbortContext | undefined;
  let digestBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    context = createProviderRequestAbortContext(params);
    const backend = params.backend;
    const [keyFingerprint, sha256] = await context.race(
      Promise.all([fingerprintKey(params.key), immutableSha256(body)]),
    );
    digestBytes = new Uint8Array(sha256.bytes);
    const expected: ImmutableObjectUploadReceipt["metadata"] = {
      sizeBytes: body.byteLength,
      checksum: sha256.receipt,
    };

    for (let attempt = 1; attempt <= MAX_IMMUTABLE_PUT_ATTEMPTS; attempt += 1) {
      let writeFailure: ImmutableWriteFailure = "none";
      const attemptBody = body.slice();
      const attemptDigest = digestBytes.slice();
      try {
        context.ensureActive();
        if (params.beforeWriteAttempt) {
          await context.race(Promise.resolve().then(params.beforeWriteAttempt));
        }
        context.ensureActive();
      } catch (error) {
        attemptBody.fill(0);
        attemptDigest.fill(0);
        throw error;
      }
      let providerRequest: Promise<unknown>;
      try {
        if (backend.runtimeBucket) {
          const onlyIf = new Headers({ "if-none-match": "*" });
          providerRequest = Promise.resolve(
            backend.runtimeBucket.put(params.key, attemptBody, {
              onlyIf,
              httpMetadata: {
                contentType: params.contentType ?? "application/octet-stream",
              },
              customMetadata: {
                [IMMUTABLE_SHA256_METADATA_KEY]: sha256.receipt.value,
              },
              sha256: attemptDigest.buffer,
            }),
          );
        } else {
          providerRequest = backend.s3Client.send(
            new PutObjectCommand({
              Bucket: backend.locator.bucket,
              Key: params.key,
              Body: attemptBody,
              ContentLength: attemptBody.byteLength,
              ContentType: params.contentType ?? "application/octet-stream",
              ChecksumSHA256: sha256.receipt.value,
              Metadata: {
                [IMMUTABLE_SHA256_METADATA_KEY]: sha256.receipt.value,
              },
              IfNoneMatch: "*",
            }),
            { abortSignal: context.signal },
          );
        }
      } catch (error) {
        attemptBody.fill(0);
        attemptDigest.fill(0);
        throw error;
      }
      const trackedRequest = providerRequest.finally(() => {
        attemptBody.fill(0);
        attemptDigest.fill(0);
      });
      try {
        const result = await context.race(trackedRequest);
        // Native R2 returns null when the create-only precondition fails.
        if (backend.runtimeBucket && result === null) writeFailure = "precondition";
      } catch (error) {
        // A timed-out binding request may settle after this execution returns.
        // Its private attempt buffer is wiped only after that provider request
        // settles, so late provider consumption cannot observe zeroed bytes.
        void trackedRequest.catch(() => undefined);
        if (context.signal.aborted) throw context.failure();
        // error-policy:J1 provider failures are reconciled below and translated
        // to static key-free domain errors at this storage boundary.
        writeFailure = classifyImmutableWriteFailure(error);
      }

      // A provider that rejected or does not implement create-only PUT cannot
      // establish immutable-write authority. Do not adopt a matching HEAD from
      // a pre-existing or non-conformant write under either failure class.
      if (writeFailure === "unsupported") {
        throw new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_IMMUTABLE_PUT_UNSUPPORTED",
          "Storage provider does not support create-only immutable object uploads",
        );
      }
      if (writeFailure === "fatal") {
        throw new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_UPLOAD_FAILED",
          "Storage provider rejected the immutable object upload",
        );
      }

      try {
        const observed = await headObjectOnBackend(
          backend,
          params.key,
          keyFingerprint,
          true,
          undefined,
          context,
        );
        const receipt = immutableReceiptFromHead(observed, expected);
        if (receipt) return receipt;
      } catch (error) {
        if (context.signal.aborted) throw context.failure();
        if (
          error instanceof ObjectStorageLifecycleError &&
          error.code === "OBJECT_STORAGE_IMMUTABLE_CONFLICT"
        ) {
          throw error;
        }
        if (
          error instanceof ObjectStorageLifecycleError &&
          error.code === "OBJECT_STORAGE_METADATA_INVALID"
        ) {
          throw new ObjectStorageLifecycleError(
            "OBJECT_STORAGE_IMMUTABLE_CONFLICT",
            "Immutable object upload refused because existing content could not be verified",
          );
        }
        if (!isRetryableProviderError(error)) {
          throw new ObjectStorageLifecycleError(
            "OBJECT_STORAGE_UPLOAD_UNCONFIRMED",
            "Immutable object upload could not be confirmed by the storage provider",
          );
        }
        writeFailure = "retryable";
      }

      if (attempt === MAX_IMMUTABLE_PUT_ATTEMPTS) {
        throw new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_UPLOAD_RETRY_EXHAUSTED",
          "Immutable object upload exhausted its bounded retry budget",
        );
      }
      await immutableRetryBackoff(attempt, context);
    }

    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_UPLOAD_RETRY_EXHAUSTED",
      "Immutable object upload exhausted its bounded retry budget",
    );
  } finally {
    body.fill(0);
    digestBytes?.fill(0);
    context?.dispose();
  }
}

/** Put an immutable object using the legacy process-global backend selector. */
export async function putImmutableObject(
  params: PutImmutableObjectInput,
): Promise<ImmutableObjectUploadReceipt> {
  requireExactKey(params.key);
  if (params.body.byteLength > MAX_IMMUTABLE_SINGLE_PUT_BYTES) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_UPLOAD_TOO_LARGE",
      "Immutable single-PUT object exceeds the bounded upload limit",
    );
  }
  return putImmutableObjectOnBackend({
    ...params,
    backend: await resolveLifecycleBackend({ singleAttemptS3: true }),
  });
}

/** Put an immutable object on a caller-resolved exact backend. */
export async function putImmutableObjectAtBackend(params: {
  backend: ExactObjectStorageBackend;
  key: PutImmutableObjectInput["key"];
  body: PutImmutableObjectInput["body"];
  contentType?: PutImmutableObjectInput["contentType"];
  signal?: PutImmutableObjectInput["signal"];
  deadline?: PutImmutableObjectInput["deadline"];
  beforeWriteAttempt?: PutImmutableObjectInput["beforeWriteAttempt"];
  transferBodyOwnership?: PutImmutableObjectInput["transferBodyOwnership"];
}): Promise<ImmutableObjectUploadReceipt> {
  return putImmutableObjectOnBackend(params);
}

/**
 * Delete one exact immutable object and prove absence on the same backend.
 *
 * The caller must supply a prior HEAD locator. This prevents a retry from
 * treating a 404 in a newly-repointed bucket as success, and prevents an
 * overwritten key generation from being deleted under a stale catalog row.
 * S3 provider versions are passed as `VersionId`. Worker bindings and
 * checksum/ETag locators have no conditional-delete primitive: HEAD→DELETE is
 * therefore not a provider CAS, and the authoritative catalog MUST forbid
 * overwriting a key for its entire retention/GC lifetime.
 */
async function deleteObjectOnBackend(
  backend: ExactObjectStorageBackend,
  target: ObjectDeleteTarget,
  control: ProviderRequestAbortContext,
): Promise<ObjectDeleteReceipt> {
  control.ensureActive();
  requireExactKey(target.key);
  requireExactBackendLocator(backend.locator);
  const keyFingerprint = await fingerprintKey(target.key);
  const currentScope = makeLocator(backend, keyFingerprint);
  if (!locatorScopeMatches(target.locator, currentScope)) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_MISMATCH",
      "Object deletion locator no longer matches the configured backend",
    );
  }

  const providerVersionId =
    !backend.runtimeBucket && target.locator.versionSource === "provider"
      ? (target.locator.version ?? undefined)
      : undefined;
  const before = await headObjectOnBackend(
    backend,
    target.key,
    keyFingerprint,
    false,
    providerVersionId,
    control,
  );
  if (before.status === "absent") {
    return {
      status: "already-absent",
      // Preserve the catalogued generation: absence is idempotent only for
      // the exact locator whose backend/bucket/key fingerprint was validated.
      locator: target.locator,
      metadata: null,
      providerRequestId: null,
      verifiedAbsent: true,
    };
  }
  if (
    before.locator.version !== target.locator.version ||
    before.locator.versionSource !== target.locator.versionSource
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_VERSION_MISMATCH",
      "Object deletion refused because the observed object generation changed",
    );
  }

  let providerRequestId: string | null = null;
  if (backend.runtimeBucket) {
    await control.race(backend.runtimeBucket.delete(target.key));
  } else {
    try {
      const output = await control.race(
        backend.s3Client.send(
          new DeleteObjectCommand({
            Bucket: backend.locator.bucket,
            Key: target.key,
            VersionId:
              target.locator.versionSource === "provider"
                ? (target.locator.version ?? undefined)
                : undefined,
            IfMatch:
              target.locator.versionSource === "etag"
                ? (target.locator.version ?? undefined)
                : undefined,
          }),
          { abortSignal: control.signal },
        ),
      );
      providerRequestId = output.$metadata.requestId ?? null;
    } catch (error) {
      if (providerHttpStatus(error) === 412) {
        throw new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_VERSION_MISMATCH",
          "Object deletion refused because the provider ETag changed",
        );
      }
      if (!isS3ObjectNotFound(error)) throw error;
    }
  }

  const after = await headObjectOnBackend(
    backend,
    target.key,
    keyFingerprint,
    false,
    providerVersionId,
    control,
  );
  if (after.status !== "absent") {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_DELETE_UNCONFIRMED",
      "Object storage did not confirm absence after exact-key deletion",
    );
  }
  return {
    status: "deleted",
    locator: before.locator,
    metadata: before.metadata,
    providerRequestId,
    verifiedAbsent: true,
  };
}

/** Delete using the legacy process-global backend selector. */
export async function deleteObject(
  target: ObjectDeleteTarget,
  control: ObjectRequestControl = {},
): Promise<ObjectDeleteReceipt> {
  const context = createProviderRequestAbortContext(control, {
    operation: "Exact object deletion",
    deadlineCode: "OBJECT_STORAGE_DELETE_DEADLINE_EXCEEDED",
    abortCode: "OBJECT_STORAGE_DELETE_ABORTED",
  });
  try {
    return await context.race(
      resolveLifecycleBackend().then((backend) => deleteObjectOnBackend(backend, target, context)),
    );
  } finally {
    context.dispose();
  }
}

/** Delete one exact object on a caller-resolved backend and prove absence. */
export async function deleteObjectAtBackend(params: {
  backend: ExactObjectStorageBackend;
  target: ObjectDeleteTarget;
  control?: ObjectRequestControl;
}): Promise<ObjectDeleteReceipt> {
  const context = createProviderRequestAbortContext(params.control ?? {}, {
    operation: "Exact object deletion",
    deadlineCode: "OBJECT_STORAGE_DELETE_DEADLINE_EXCEEDED",
    abortCode: "OBJECT_STORAGE_DELETE_ABORTED",
  });
  try {
    return await deleteObjectOnBackend(params.backend, params.target, context);
  } finally {
    context.dispose();
  }
}

/**
 * Exact-key compatibility deletion for legacy rows that predate durable
 * provider locators. New catalog objects must use `deleteObject` with a
 * previously persisted locator receipt.
 */
export async function deleteLegacyObject(key: string): Promise<void> {
  requireExactKey(key);
  const runtimeBucket = getRuntimeR2Bucket();
  if (runtimeBucket) {
    await runtimeBucket.delete(key);
    return;
  }

  const bucket = heavyPayloadBucket();
  const client = getObjectStorageClient();
  if (!bucket || !client) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_UNCONFIGURED",
      "Legacy exact-key deletion requested without a configured storage backend",
    );
  }
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function offloadTextField(params: {
  namespace: ObjectNamespace;
  organizationId: string;
  objectId: string;
  field: string;
  createdAt: Date;
  value: string | null | undefined;
  keepPreview?: boolean;
  inlineValueWhenOffloaded?: string;
  version?: string;
  immutable?: boolean;
}): Promise<OffloadedField<string>> {
  if (params.value == null) return { value: null, storage: "inline", key: null };
  if (!shouldOffload(params.value)) {
    assertInlinePayloadFits(params.field, params.value);
    return { value: params.value, storage: "inline", key: null };
  }

  const key = await putObjectText({
    namespace: params.namespace,
    organizationId: params.organizationId,
    objectId: params.objectId,
    field: params.field,
    createdAt: params.createdAt,
    body: params.value,
    contentType: "text/plain; charset=utf-8",
    version: params.version,
    immutable: params.immutable,
  });

  return {
    value:
      params.inlineValueWhenOffloaded ??
      (params.keepPreview === false ? "" : preview(params.value)),
    storage: "r2",
    key,
  };
}

export async function offloadJsonField<T>(params: {
  namespace: ObjectNamespace;
  organizationId: string;
  objectId: string;
  field: string;
  createdAt: Date;
  value: T | null | undefined;
  inlineValueWhenOffloaded: T | null;
  version?: string;
  immutable?: boolean;
}): Promise<OffloadedField<T>> {
  if (params.value == null) return { value: null, storage: "inline", key: null };
  const body = JSON.stringify(params.value);
  if (!shouldOffload(body)) {
    // Structured payloads cannot be truncated without becoming invalid, so an
    // oversize inline JSON write always fails rather than degrading silently.
    assertInlinePayloadFits(params.field, body);
    return { value: params.value, storage: "inline", key: null };
  }

  const key = await putObjectText({
    namespace: params.namespace,
    organizationId: params.organizationId,
    objectId: params.objectId,
    field: params.field,
    createdAt: params.createdAt,
    body,
    contentType: "application/json; charset=utf-8",
    version: params.version,
    immutable: params.immutable,
  });

  return {
    value: params.inlineValueWhenOffloaded,
    storage: "r2",
    key,
  };
}

export async function hydrateTextField(params: {
  storage: string;
  key: string | null;
  inlineValue: string | null;
  strict?: boolean;
}): Promise<string | null> {
  if (params.storage !== "r2") {
    if (params.strict && (params.storage !== "inline" || params.key !== null)) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_FIELD_POINTER_INVALID",
        "Object-backed field has an invalid inline pointer state",
      );
    }
    return params.inlineValue;
  }
  if (!params.key) {
    if (!params.strict) return params.inlineValue;
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_FIELD_POINTER_INVALID",
      "Object-backed field is missing its exact object key",
    );
  }
  try {
    const hydrated = await getObjectText(params.key);
    if (hydrated !== null) return hydrated;
  } catch (cause) {
    // error-policy:J2 preserve the provider failure behind a key-free storage error.
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_FIELD_UNAVAILABLE",
      "Object-backed field is unavailable at the storage boundary",
      { cause },
    );
  }
  if (!params.strict) return params.inlineValue;
  throw new ObjectStorageLifecycleError(
    "OBJECT_STORAGE_FIELD_UNAVAILABLE",
    "Object-backed field is unavailable at the storage boundary",
  );
}

export async function hydrateJsonField<T>(params: {
  storage: string;
  key: string | null;
  inlineValue: T | null;
  strict?: boolean;
}): Promise<T | null> {
  if (params.storage !== "r2") {
    if (params.strict && (params.storage !== "inline" || params.key !== null)) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_FIELD_POINTER_INVALID",
        "Object-backed JSON field has an invalid inline pointer state",
      );
    }
    return params.inlineValue;
  }
  if (!params.key) {
    if (!params.strict) return params.inlineValue;
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_FIELD_POINTER_INVALID",
      "Object-backed JSON field is missing its exact object key",
    );
  }

  let raw: string | null;
  try {
    raw = await getObjectText(params.key);
  } catch (cause) {
    // error-policy:J2 preserve the provider failure behind a key-free storage error.
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_FIELD_UNAVAILABLE",
      "Object-backed JSON field is unavailable at the storage boundary",
      { cause },
    );
  }
  if (raw === null || (!params.strict && raw.length === 0)) {
    if (!params.strict) return params.inlineValue;
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_FIELD_UNAVAILABLE",
      "Object-backed JSON field is unavailable at the storage boundary",
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    // error-policy:J2 preserve the parse failure without exposing object content.
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_FIELD_JSON_INVALID",
      "Object-backed JSON field contains malformed JSON",
      { cause },
    );
  }
}
