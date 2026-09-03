/** Public multipart contracts plus exact, effect-free validation helpers. */

import { createHash } from "node:crypto";
import {
  DEFAULT_IMMUTABLE_UPLOAD_DURATION_MS,
  type ExactObjectStorageBackend,
  type ImmutableObjectUploadReceipt,
  MAX_IMMUTABLE_UPLOAD_DURATION_MS,
  type ObjectRequestControl,
  ObjectStorageLifecycleError,
  type ObjectStorageTransport,
} from "./object-store";
import type { ObjectStorageProvider } from "./s3-compatible-client";

export const MULTIPART_OBJECT_PART_BYTES = 8 * 1024 * 1024;
export const MAX_MULTIPART_OBJECT_BYTES = 1024 * 1024 * 1024;
export const MAX_MULTIPART_OBJECT_PARTS = 128;
export const LATE_MULTIPART_CREATE_ABORT_MS = 10_000;
export const DEFAULT_MULTIPART_REQUEST_DURATION_MS = DEFAULT_IMMUTABLE_UPLOAD_DURATION_MS;
export const MAX_MULTIPART_REQUEST_DURATION_MS = MAX_IMMUTABLE_UPLOAD_DURATION_MS;
export const MULTIPART_SHA256_METADATA_KEY = "eliza-content-sha256";
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export interface MultipartObjectRequestControl extends ObjectRequestControl {
  /** Normally delegates to `ExecutionContext.waitUntil`. */
  readonly registerLateSettlement: (settlement: Promise<void>) => void;
}

export interface MultipartObjectUploadPlan {
  /** Globally unique immutable key held only by the fenced durable caller. */
  readonly key: string;
  readonly expectedSize: number;
  /** Canonical lowercase hex SHA-256 of the complete object body. */
  readonly expectedSha256: string;
  readonly contentType?: string;
}

export interface CreateMultipartObjectUploadInput extends MultipartObjectUploadPlan {
  readonly backend: ExactObjectStorageBackend;
  readonly control: MultipartObjectRequestControl;
}

export interface ResumeMultipartObjectUploadInput {
  readonly backend: ExactObjectStorageBackend;
  readonly handle: MultipartObjectUploadHandle;
  /** Only receipts durably recorded after provider acknowledgement. */
  readonly acknowledgedParts?: readonly MultipartObjectPartReceipt[];
  readonly control: MultipartObjectRequestControl;
}

export interface UploadMultipartObjectPartInput {
  readonly partNumber: number;
  readonly body: ArrayBuffer | Uint8Array;
  readonly control: MultipartObjectRequestControl;
}

export interface ValidatedMultipartObjectUploadPlan {
  readonly key: string;
  readonly expectedSize: number;
  readonly expectedSha256: string;
  readonly contentType: string;
  readonly partCount: number;
}

interface MultipartHandleFields extends ValidatedMultipartObjectUploadPlan {
  transport: ObjectStorageTransport;
  provider: ObjectStorageProvider;
  endpointAlias: string;
  backendIdentityFingerprint: string;
  bucket: string;
  region: string;
  uploadId: string;
  keyFingerprint: string;
  uploadIdFingerprint: string;
  planFingerprint: string;
  handleFingerprint: string;
}

export interface SerializedMultipartObjectUploadHandle {
  version: 1;
  transport: ObjectStorageTransport;
  provider: ObjectStorageProvider;
  backendIdentityFingerprint: string;
  keyFingerprint: string;
  uploadIdFingerprint: string;
  planFingerprint: string;
  handleFingerprint: string;
  expectedSize: number;
  partSizeBytes: number;
  partCount: number;
}

export interface RehydrateMultipartObjectUploadHandleInput extends MultipartObjectUploadPlan {
  readonly backend: ExactObjectStorageBackend;
  /** Private durable column; never include it in a serialized receipt. */
  readonly uploadId: string;
  readonly receipt: SerializedMultipartObjectUploadHandle;
}

/** Physical locator fields are non-enumerable and omitted from JSON/logs. */
export class MultipartObjectUploadHandle {
  readonly version = 1 as const;
  readonly transport: ObjectStorageTransport;
  readonly provider: ObjectStorageProvider;
  readonly endpointAlias: string;
  readonly backendIdentityFingerprint: string;
  readonly bucket: string;
  readonly region: string;
  readonly key: string;
  readonly uploadId: string;
  readonly keyFingerprint: string;
  readonly uploadIdFingerprint: string;
  readonly planFingerprint: string;
  readonly handleFingerprint: string;
  readonly expectedSize: number;
  readonly expectedSha256: string;
  readonly contentType: string;
  readonly partSizeBytes = MULTIPART_OBJECT_PART_BYTES;
  readonly partCount: number;

  constructor(input: MultipartHandleFields) {
    this.transport = input.transport;
    this.provider = input.provider;
    this.endpointAlias = input.endpointAlias;
    this.backendIdentityFingerprint = input.backendIdentityFingerprint;
    this.bucket = input.bucket;
    this.region = input.region;
    this.key = input.key;
    this.uploadId = input.uploadId;
    this.keyFingerprint = input.keyFingerprint;
    this.uploadIdFingerprint = input.uploadIdFingerprint;
    this.planFingerprint = input.planFingerprint;
    this.handleFingerprint = input.handleFingerprint;
    this.expectedSize = input.expectedSize;
    this.expectedSha256 = input.expectedSha256;
    this.contentType = input.contentType;
    this.partCount = input.partCount;
    for (const privateField of ["endpointAlias", "bucket", "region", "key", "uploadId"] as const) {
      Object.defineProperty(this, privateField, { enumerable: false });
    }
    Object.freeze(this);
  }

  toJSON(): SerializedMultipartObjectUploadHandle {
    return {
      version: this.version,
      transport: this.transport,
      provider: this.provider,
      backendIdentityFingerprint: this.backendIdentityFingerprint,
      keyFingerprint: this.keyFingerprint,
      uploadIdFingerprint: this.uploadIdFingerprint,
      planFingerprint: this.planFingerprint,
      handleFingerprint: this.handleFingerprint,
      expectedSize: this.expectedSize,
      partSizeBytes: this.partSizeBytes,
      partCount: this.partCount,
    };
  }
}

/** A provider-acknowledged part safe to persist and replay into completion. */
export class MultipartObjectPartReceipt {
  readonly handleFingerprint: string;
  readonly partNumber: number;
  readonly sizeBytes: number;
  readonly bodySha256: string;
  readonly etag: string;
  readonly providerAcknowledged = true as const;

  constructor(input: {
    handleFingerprint: string;
    partNumber: number;
    sizeBytes: number;
    bodySha256: string;
    etag: string;
  }) {
    this.handleFingerprint = input.handleFingerprint;
    this.partNumber = input.partNumber;
    this.sizeBytes = input.sizeBytes;
    this.bodySha256 = input.bodySha256;
    this.etag = input.etag;
    Object.freeze(this);
  }
}

export interface MultipartObjectUploadSession {
  readonly handle: MultipartObjectUploadHandle;
  acknowledgedParts(): readonly MultipartObjectPartReceipt[];
  uploadPart(input: UploadMultipartObjectPartInput): Promise<MultipartObjectPartReceipt>;
  complete(control: MultipartObjectRequestControl): Promise<ImmutableObjectUploadReceipt>;
  abort(control: MultipartObjectRequestControl): Promise<void>;
}

export interface ProviderPart {
  readonly partNumber: number;
  readonly etag: string;
  readonly checksumBase64?: string;
}

export interface ProviderMultipartHandle {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(
    partNumber: number,
    body: Uint8Array,
    checksumBase64: string,
    signal: AbortSignal,
  ): Promise<ProviderPart>;
  complete(parts: readonly MultipartObjectPartReceipt[], signal: AbortSignal): Promise<unknown>;
  abort(signal: AbortSignal): Promise<void>;
}

export interface QueuedOperation<T> {
  readonly result: Promise<T>;
  readonly settlement: Promise<void>;
}

export function lifecycle(
  code: ConstructorParameters<typeof ObjectStorageLifecycleError>[0],
  message: string,
  cause?: unknown,
): ObjectStorageLifecycleError {
  return new ObjectStorageLifecycleError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function requireExactKey(key: string): string {
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 1_024 ||
    key.includes("\0") ||
    key.trim() !== key ||
    new TextEncoder().encode(key).byteLength > 1_024
  ) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart object upload requires an exact key no larger than 1024 UTF-8 bytes",
    );
  }
  return key;
}

function requireContentType(value: string | undefined): string {
  const contentType = value ?? DEFAULT_CONTENT_TYPE;
  if (
    contentType.length === 0 ||
    contentType.length > 256 ||
    contentType.trim() !== contentType ||
    /[\u0000-\u001f\u007f]/.test(contentType)
  ) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart object upload requires a canonical content type",
    );
  }
  return contentType;
}

export function requirePlan(input: MultipartObjectUploadPlan): ValidatedMultipartObjectUploadPlan {
  const key = requireExactKey(input.key);
  if (
    !Number.isSafeInteger(input.expectedSize) ||
    input.expectedSize <= 0 ||
    input.expectedSize > MAX_MULTIPART_OBJECT_BYTES
  ) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart object upload requires a positive size no larger than 1 GiB",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.expectedSha256)) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart object upload requires a canonical object SHA-256",
    );
  }
  const partCount = Math.ceil(input.expectedSize / MULTIPART_OBJECT_PART_BYTES);
  if (partCount < 1 || partCount > MAX_MULTIPART_OBJECT_PARTS) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart object upload exceeds the bounded part count",
    );
  }
  return {
    key,
    expectedSize: input.expectedSize,
    expectedSha256: input.expectedSha256,
    contentType: requireContentType(input.contentType),
    partCount,
  };
}

export function requireBackend(backend: ExactObjectStorageBackend): ExactObjectStorageBackend {
  const locator = backend.locator;
  if (
    !locator ||
    (locator.transport !== "worker-r2-binding" && locator.transport !== "s3-compatible") ||
    (locator.provider !== "r2" && locator.provider !== "s3") ||
    locator.endpointAlias.length === 0 ||
    locator.endpointAlias.trim() !== locator.endpointAlias ||
    locator.bucket.length === 0 ||
    locator.bucket.trim() !== locator.bucket ||
    locator.region.length === 0 ||
    locator.region.trim() !== locator.region ||
    !/^sha256:[0-9a-f]{64}$/.test(locator.backendIdentityFingerprint)
  ) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart object upload requires exact backend authority",
    );
  }
  const frozenLocator = Object.freeze({ ...locator });
  if (backend.runtimeBucket) {
    return Object.freeze({ locator: frozenLocator, runtimeBucket: backend.runtimeBucket });
  }
  return Object.freeze({ locator: frozenLocator, s3Client: backend.s3Client });
}

export function requireUploadId(uploadId: unknown): string {
  if (
    typeof uploadId !== "string" ||
    uploadId.length === 0 ||
    uploadId.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(uploadId)
  ) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
      "Multipart storage returned an invalid upload handle",
    );
  }
  return uploadId;
}

export function normalizedEtag(etag: unknown): string {
  if (
    typeof etag !== "string" ||
    etag.length === 0 ||
    etag.length > 4_096 ||
    /[\r\n\0]/.test(etag)
  ) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_PART_FAILED",
      "Multipart storage returned an invalid part acknowledgement",
    );
  }
  return etag;
}

export function providerStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const shaped = error as {
    status?: unknown;
    statusCode?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  const value = shaped.$metadata?.httpStatusCode ?? shaped.statusCode ?? shaped.status;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function providerCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const shaped = error as { name?: unknown; code?: unknown; Code?: unknown };
  const value = shaped.name ?? shaped.code ?? shaped.Code;
  return typeof value === "string" ? value : null;
}

export function isNotFound(error: unknown): boolean {
  const code = providerCode(error);
  return (
    providerStatus(error) === 404 &&
    (code === "NotFound" || code === "NoSuchKey" || code === "NoSuchVersion" || code === "404")
  );
}

export function isNoSuchUpload(error: unknown): boolean {
  return (
    (providerStatus(error) === 404 && providerCode(error) === "NoSuchUpload") ||
    // Workers R2 appends its numeric error code to Error.message and does not
    // expose the S3 HTTP/code fields; 10024 is the documented NoSuchUpload code.
    (error instanceof Error && /\(10024\)\s*$/.test(error.message))
  );
}

export function isAuthoritativeCreateFailure(error: unknown): boolean {
  const status = providerStatus(error);
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export async function sha256Hex(value: Uint8Array | string): Promise<string> {
  return createHash("sha256").update(value).digest("hex");
}

function base64FromBytes(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    output += alphabet.charAt(first >> 2);
    output += alphabet.charAt(((first & 3) << 4) | (second >> 4));
    output += index + 1 < bytes.length ? alphabet.charAt(((second & 15) << 2) | (third >> 6)) : "=";
    output += index + 2 < bytes.length ? alphabet.charAt(third & 63) : "=";
  }
  return output;
}

export function sha256HexToBase64(hex: string): string {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  const result = base64FromBytes(bytes);
  bytes.fill(0);
  return result;
}

export function exactPartSize(handle: MultipartObjectUploadHandle, partNumber: number): number {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > handle.partCount) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_INVALID",
      "Multipart part number is outside the exact object plan",
    );
  }
  return partNumber === handle.partCount
    ? handle.expectedSize - (handle.partCount - 1) * MULTIPART_OBJECT_PART_BYTES
    : MULTIPART_OBJECT_PART_BYTES;
}

export async function buildHandle(input: {
  backend: ExactObjectStorageBackend;
  plan: ValidatedMultipartObjectUploadPlan;
  uploadId: string;
}): Promise<MultipartObjectUploadHandle> {
  const locator = input.backend.locator;
  const uploadId = requireUploadId(input.uploadId);
  const keyFingerprint = `sha256:${await sha256Hex(input.plan.key)}`;
  const uploadIdFingerprint = `sha256:${await sha256Hex(uploadId)}`;
  const planFingerprint = `sha256:${await sha256Hex(
    JSON.stringify({
      version: 1,
      expectedSize: input.plan.expectedSize,
      expectedSha256: input.plan.expectedSha256,
      contentType: input.plan.contentType,
      partSizeBytes: MULTIPART_OBJECT_PART_BYTES,
      partCount: input.plan.partCount,
    }),
  )}`;
  const handleFingerprint = `sha256:${await sha256Hex(
    JSON.stringify({
      version: 1,
      transport: locator.transport,
      provider: locator.provider,
      endpointAlias: locator.endpointAlias,
      backendIdentityFingerprint: locator.backendIdentityFingerprint,
      bucket: locator.bucket,
      region: locator.region,
      key: input.plan.key,
      uploadId,
      keyFingerprint,
      uploadIdFingerprint,
      planFingerprint,
    }),
  )}`;
  return new MultipartObjectUploadHandle({
    ...locator,
    ...input.plan,
    uploadId,
    keyFingerprint,
    uploadIdFingerprint,
    planFingerprint,
    handleFingerprint,
  });
}

function serializedHandleMatches(
  expected: MultipartObjectUploadHandle,
  actual: SerializedMultipartObjectUploadHandle,
): boolean {
  const exactKeys = [
    "backendIdentityFingerprint",
    "expectedSize",
    "handleFingerprint",
    "keyFingerprint",
    "partCount",
    "partSizeBytes",
    "planFingerprint",
    "provider",
    "transport",
    "uploadIdFingerprint",
    "version",
  ];
  return (
    actual !== null &&
    typeof actual === "object" &&
    Object.keys(actual).sort().join("\0") === exactKeys.join("\0") &&
    actual.version === expected.version &&
    actual.transport === expected.transport &&
    actual.provider === expected.provider &&
    actual.backendIdentityFingerprint === expected.backendIdentityFingerprint &&
    actual.keyFingerprint === expected.keyFingerprint &&
    actual.uploadIdFingerprint === expected.uploadIdFingerprint &&
    actual.planFingerprint === expected.planFingerprint &&
    actual.handleFingerprint === expected.handleFingerprint &&
    actual.expectedSize === expected.expectedSize &&
    actual.partSizeBytes === expected.partSizeBytes &&
    actual.partCount === expected.partCount
  );
}

export async function rehydrateMultipartObjectUploadHandle(
  input: RehydrateMultipartObjectUploadHandleInput,
): Promise<MultipartObjectUploadHandle> {
  const backend = requireBackend(input.backend);
  const plan = requirePlan(input);
  const uploadId = requireUploadId(input.uploadId);
  const receipt =
    input.receipt !== null && typeof input.receipt === "object"
      ? Object.freeze({ ...input.receipt })
      : input.receipt;
  const expected = await buildHandle({
    backend,
    plan,
    uploadId,
  });
  if (!serializedHandleMatches(expected, receipt)) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
      "Serialized multipart receipt does not match its private exact locator",
    );
  }
  return expected;
}

export async function assertHandleMatchesBackend(
  backend: ExactObjectStorageBackend,
  handle: MultipartObjectUploadHandle,
): Promise<MultipartObjectUploadHandle> {
  if (!handle || typeof handle !== "object") {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
      "Multipart resume requires an exact upload handle",
    );
  }
  const actual = Object.freeze({
    version: handle.version,
    transport: handle.transport,
    provider: handle.provider,
    endpointAlias: handle.endpointAlias,
    backendIdentityFingerprint: handle.backendIdentityFingerprint,
    bucket: handle.bucket,
    region: handle.region,
    key: handle.key,
    uploadId: handle.uploadId,
    keyFingerprint: handle.keyFingerprint,
    uploadIdFingerprint: handle.uploadIdFingerprint,
    planFingerprint: handle.planFingerprint,
    handleFingerprint: handle.handleFingerprint,
    expectedSize: handle.expectedSize,
    expectedSha256: handle.expectedSha256,
    contentType: handle.contentType,
    partSizeBytes: handle.partSizeBytes,
    partCount: handle.partCount,
  });
  const plan = requirePlan(actual);
  const expected = await buildHandle({ backend, plan, uploadId: actual.uploadId });
  if (
    actual.version !== expected.version ||
    actual.transport !== expected.transport ||
    actual.provider !== expected.provider ||
    actual.endpointAlias !== expected.endpointAlias ||
    actual.backendIdentityFingerprint !== expected.backendIdentityFingerprint ||
    actual.bucket !== expected.bucket ||
    actual.region !== expected.region ||
    actual.keyFingerprint !== expected.keyFingerprint ||
    actual.uploadIdFingerprint !== expected.uploadIdFingerprint ||
    actual.planFingerprint !== expected.planFingerprint ||
    actual.handleFingerprint !== expected.handleFingerprint ||
    actual.partSizeBytes !== expected.partSizeBytes ||
    actual.partCount !== expected.partCount ||
    actual.contentType !== expected.contentType
  ) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
      "Multipart upload handle does not match the exact backend and object plan",
    );
  }
  return expected;
}

export function snapshotMultipartPartReceipt(
  receipt: MultipartObjectPartReceipt,
): MultipartObjectPartReceipt {
  if (!receipt || typeof receipt !== "object") {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
      "Multipart resume requires exact provider-acknowledged part receipts",
    );
  }
  return Object.freeze({
    handleFingerprint: receipt.handleFingerprint,
    partNumber: receipt.partNumber,
    sizeBytes: receipt.sizeBytes,
    bodySha256: receipt.bodySha256,
    etag: receipt.etag,
    providerAcknowledged: receipt.providerAcknowledged,
  }) as MultipartObjectPartReceipt;
}

export function validateReceiptForHandle(
  handle: MultipartObjectUploadHandle,
  receipt: MultipartObjectPartReceipt,
): void {
  const expectedSize = exactPartSize(handle, receipt.partNumber);
  if (
    !receipt ||
    receipt.providerAcknowledged !== true ||
    receipt.handleFingerprint !== handle.handleFingerprint ||
    receipt.sizeBytes !== expectedSize ||
    !/^[0-9a-f]{64}$/.test(receipt.bodySha256) ||
    normalizedEtag(receipt.etag) !== receipt.etag
  ) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
      "Multipart part receipt does not match the exact upload handle",
    );
  }
}

export function hasEveryExactPart(
  handle: MultipartObjectUploadHandle,
  receipts: readonly MultipartObjectPartReceipt[],
): boolean {
  if (receipts.length !== handle.partCount) return false;
  const partNumbers = new Set(receipts.map((receipt) => receipt.partNumber));
  return (
    partNumbers.size === handle.partCount &&
    [...partNumbers].every((partNumber) => partNumber >= 1 && partNumber <= handle.partCount)
  );
}

export function snapshotBody(body: ArrayBuffer | Uint8Array): Uint8Array {
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (body instanceof Uint8Array) return Uint8Array.from(body);
  throw lifecycle(
    "OBJECT_STORAGE_MULTIPART_INVALID",
    "Multipart part body must be an exact byte range",
  );
}
