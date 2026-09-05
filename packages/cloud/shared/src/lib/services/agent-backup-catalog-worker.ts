/**
 * Provider-backed execution boundary for the durable backup catalogue.
 *
 * Catalogue repositories own leases/CAS. This module is the only production
 * seam that turns an R2/Hetzner provider observation into a receipt digest.
 * Callers never provide an arbitrary successful receipt.
 */

import type {
  AgentBackupOperationExecution,
  ReserveAgentBackupObjectInput,
} from "../../db/repositories/agent-backup-catalog";
import {
  markAgentBackupObjectUploading,
  markAgentBackupObjectVerified,
  recordAgentBackupObjectPresent,
  reserveAgentBackupObject,
} from "../../db/repositories/agent-backup-catalog";
import type { AgentBackupGcClaim } from "../../db/repositories/agent-backup-gc";
import {
  adoptAgentBackupGcObservedLocator,
  failAgentBackupGc,
  settleAgentBackupGc,
} from "../../db/repositories/agent-backup-gc";
import type { AgentBackupObject } from "../../db/schemas/agent-backup-catalog";
import { bytesToHex, sha256Bytes } from "../crypto/worker";
import type {
  AgentBackupObjectStore,
  AgentBackupObjectStoreRegistry,
  AgentBackupStorageAuthority,
} from "../storage/agent-backup-object-store";
import {
  type ExactObjectRead,
  MAX_IMMUTABLE_SINGLE_PUT_BYTES,
  type ObjectChecksumReceipt,
  type ObjectDeleteReceipt,
  type ObjectHeadReceipt,
  ObjectLocatorReceipt,
  type ObjectRequestControl,
  ObjectStorageLifecycleError,
} from "../storage/object-store";

const MAX_GC_RETRY_DELAY_MS = 6 * 60 * 60 * 1_000;
const GC_LEASE_SETTLEMENT_MARGIN_MS = 1_000;

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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

function sha256HexToBase64(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      "Stored backup object ciphertext digest is not canonical",
    );
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  try {
    return bytesToBase64(bytes);
  } finally {
    bytes.fill(0);
  }
}

async function sha256Canonical(value: unknown): Promise<string> {
  const digest = await sha256Bytes(new TextEncoder().encode(JSON.stringify(value)));
  try {
    return bytesToHex(digest);
  } finally {
    digest.fill(0);
  }
}

export function storedAgentBackupObjectAuthority(
  object: AgentBackupObject,
): AgentBackupStorageAuthority {
  return {
    provider: object.provider,
    transport: object.transport,
    endpointAlias: object.endpoint_alias,
    endpointIdentityFingerprint: object.endpoint_identity_fingerprint,
    bucket: object.bucket,
    region: object.region,
  };
}

function requireLocatorMatchesObject(
  object: AgentBackupObject,
  observed: ObjectHeadReceipt["locator"],
): void {
  const expectedTransport =
    object.transport === "worker-r2" ? "worker-r2-binding" : "s3-compatible";
  const expectedProvider = object.provider === "cloudflare-r2" ? "r2" : "s3";
  if (
    observed.transport !== expectedTransport ||
    observed.provider !== expectedProvider ||
    observed.endpointAlias !== object.endpoint_alias ||
    observed.backendIdentityFingerprint !== object.endpoint_identity_fingerprint ||
    observed.bucket !== object.bucket ||
    observed.region !== object.region ||
    observed.keyFingerprint !== `sha256:${object.key_fingerprint}`
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_MISMATCH",
      "Provider observation does not match the durable backup-object authority",
    );
  }
  const expected = storedObjectLocatorVersion(object);
  if (
    expected &&
    (observed.versionSource !== expected.versionSource || observed.version !== expected.version)
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_VERSION_MISMATCH",
      "Provider object generation no longer matches the durable catalogue",
    );
  }
}

function storedObjectLocatorVersion(
  object: AgentBackupObject,
): Pick<ObjectLocatorReceipt, "version" | "versionSource"> | null {
  if (object.provider_version_id) {
    return { version: object.provider_version_id, versionSource: "provider" };
  }
  if (object.provider_etag) {
    return { version: object.provider_etag, versionSource: "etag" };
  }
  if (!object.provider_checksum) return null;
  const prefix = "sha256:base64:";
  if (
    !object.provider_checksum.startsWith(prefix) ||
    object.provider_checksum.length === prefix.length
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      "Stored backup object checksum authority is not canonical",
    );
  }
  return { version: object.provider_checksum.slice(prefix.length), versionSource: "checksum" };
}

function storedObjectLocator(object: AgentBackupObject): ObjectLocatorReceipt | null {
  const version = storedObjectLocatorVersion(object);
  if (!version) return null;
  return new ObjectLocatorReceipt({
    transport: object.transport === "worker-r2" ? "worker-r2-binding" : "s3-compatible",
    provider: object.provider === "cloudflare-r2" ? "r2" : "s3",
    endpointAlias: object.endpoint_alias,
    backendIdentityFingerprint: object.endpoint_identity_fingerprint,
    bucket: object.bucket,
    region: object.region,
    keyFingerprint: `sha256:${object.key_fingerprint}`,
    ...version,
  });
}

async function resolveGcDeletionLocator(
  store: AgentBackupObjectStore,
  claim: AgentBackupGcClaim,
  control: ObjectRequestControl,
): Promise<{ claim: AgentBackupGcClaim; locator: ObjectLocatorReceipt }> {
  const { object } = claim;
  const persisted = storedObjectLocator(object);
  if (persisted) return { claim, locator: persisted };

  const observed = await store.head(object.object_key, control);
  control.signal?.throwIfAborted();
  requireLocatorMatchesObject(object, observed.locator);
  if (observed.status === "absent") {
    if (!object.provider_write_started) {
      return { claim, locator: observed.locator };
    }
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Backup upload outcome is indeterminate and no exact provider generation can be proven",
    );
  }
  if (!object.provider_write_started) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_IMMUTABLE_CONFLICT",
      "Provider object exists although no catalogue-authorized write was started",
    );
  }
  if (
    observed.metadata.sizeBytes !== object.size_bytes ||
    observed.metadata.checksum.algorithm !== "sha256" ||
    observed.metadata.checksum.encoding !== "base64" ||
    observed.metadata.checksum.value !== sha256HexToBase64(object.ciphertext_sha256)
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_METADATA_INVALID",
      "Unreceipted backup object does not match the reserved ciphertext authority",
    );
  }
  const ownerId = claim.outbox.claim_owner;
  const generation = claim.outbox.claim_generation;
  if (!ownerId || !generation) {
    throw new Error("Claimed backup GC intent is missing its execution fence");
  }
  const recoveredUploadReceiptDigest = await sha256Canonical({
    version: 1,
    kind: "gc-upload-reconciliation",
    outboxId: claim.outbox.id,
    organizationId: claim.outbox.organization_id,
    objectId: object.id,
    endpointIdentityFingerprint: object.endpoint_identity_fingerprint,
    keyFingerprint: object.key_fingerprint,
    locator: observed.locator.toJSON(),
    sizeBytes: observed.metadata.sizeBytes,
    checksum: observed.metadata.checksum,
  });
  const version = providerReceiptFields(observed.locator);
  const adopted = await adoptAgentBackupGcObservedLocator({
    outboxId: claim.outbox.id,
    ownerId,
    generation,
    ...version,
    providerChecksum: checksumIdentity(observed.metadata.checksum),
    uploadReceiptDigest: recoveredUploadReceiptDigest,
  });
  control.signal?.throwIfAborted();
  const locator = storedObjectLocator(adopted.object);
  if (!locator) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Persisted GC locator adoption produced no provider generation",
    );
  }
  return { claim: adopted, locator };
}

function providerReceiptFields(locator: ObjectLocatorReceipt): {
  providerVersionId: string | null;
  providerEtag: string | null;
} {
  return {
    providerVersionId: locator.versionSource === "provider" ? locator.version : null,
    providerEtag: locator.versionSource === "etag" ? locator.version : null,
  };
}

function checksumIdentity(checksum: ObjectChecksumReceipt): string {
  return `${checksum.algorithm}:${checksum.encoding}:${checksum.value}`;
}

function catalogTransport(authority: AgentBackupStorageAuthority): "worker-r2" | "s3-compatible" {
  return authority.transport;
}

function requireStoreMatchesRole(
  store: AgentBackupObjectStore,
  copyRole: "primary" | "secondary",
): void {
  const valid =
    (copyRole === "primary" && store.authority.provider === "cloudflare-r2") ||
    (copyRole === "secondary" && store.authority.provider === "hetzner-object-storage");
  if (!valid) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_MISMATCH",
      "Backup copy role does not match the configured storage authority",
    );
  }
}

function transferredBytes(body: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (body.buffer instanceof ArrayBuffer) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  const copy = new Uint8Array(new ArrayBuffer(body.byteLength));
  copy.set(body);
  return copy;
}

function wipeInputBytes(body: ArrayBuffer | Uint8Array): void {
  (body instanceof ArrayBuffer ? new Uint8Array(body) : body).fill(0);
}

export interface ExecuteAgentBackupObjectUploadInput
  extends Omit<
    ReserveAgentBackupObjectInput,
    "transport" | "provider" | "endpointIdentityFingerprint" | "bucket" | "region" | "sizeBytes"
  > {
  registry: AgentBackupObjectStoreRegistry;
  /** Transferred mutable bytes; the worker wipes this exact range on settlement. */
  body: ArrayBuffer | Uint8Array;
  contentType?: string;
  signal?: AbortSignal;
  /** Absolute wall-clock deadline shared by PUT, HEAD, and retry backoff. */
  deadline?: Date;
  /** Revalidates the fenced operation lease before provider mutation. */
  revalidateLease(): Promise<void>;
  repository?: AgentBackupObjectUploadRepository;
}

export interface AgentBackupObjectUploadRepository {
  reserveObject: typeof reserveAgentBackupObject;
  markUploading: typeof markAgentBackupObjectUploading;
  recordPresent: typeof recordAgentBackupObjectPresent;
  markVerified: typeof markAgentBackupObjectVerified;
}

const DEFAULT_UPLOAD_REPOSITORY: AgentBackupObjectUploadRepository = {
  reserveObject: reserveAgentBackupObject,
  markUploading: markAgentBackupObjectUploading,
  recordPresent: recordAgentBackupObjectPresent,
  markVerified: markAgentBackupObjectVerified,
};

/**
 * Reserve a repository-owned key, durably mark provider-write intent, then
 * create and verify one immutable encrypted object under the fenced lease.
 */
export async function executeAgentBackupObjectUpload(
  input: ExecuteAgentBackupObjectUploadInput,
): Promise<AgentBackupObject> {
  if (input.body.byteLength > MAX_IMMUTABLE_SINGLE_PUT_BYTES) {
    wipeInputBytes(input.body);
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_UPLOAD_TOO_LARGE",
      "Immutable single-PUT object exceeds the bounded upload limit",
    );
  }
  const repository = input.repository ?? DEFAULT_UPLOAD_REPOSITORY;
  const store = input.registry.forNewObject(input.endpointAlias);
  requireStoreMatchesRole(store, input.copyRole);
  const body = transferredBytes(input.body);
  let bodyDigest: Uint8Array | undefined;
  try {
    bodyDigest = await sha256Bytes(body);
    const bodyDigestHex = bytesToHex(bodyDigest);
    const bodyDigestBase64 = bytesToBase64(bodyDigest);
    if (bodyDigestHex !== input.ciphertextSha256) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_METADATA_INVALID",
        "Encrypted backup chunk does not match its catalogue ciphertext digest",
      );
    }

    const reserved = await repository.reserveObject({
      organizationId: input.organizationId,
      backupId: input.backupId,
      copyRole: input.copyRole,
      component: input.component,
      chunkIndex: input.chunkIndex,
      transport: catalogTransport(store.authority),
      provider: store.authority.provider,
      endpointAlias: store.authority.endpointAlias,
      endpointIdentityFingerprint: store.authority.endpointIdentityFingerprint,
      bucket: store.authority.bucket,
      region: store.authority.region,
      contentHmacSha256: input.contentHmacSha256,
      ciphertextSha256: input.ciphertextSha256,
      sizeBytes: body.byteLength,
      execution: input.execution,
    });
    const uploading = await repository.markUploading({
      organizationId: input.organizationId,
      objectId: reserved.id,
      execution: input.execution,
    });
    const markerMatchesReservation =
      uploading.id === reserved.id &&
      uploading.organization_id === reserved.organization_id &&
      uploading.backup_id === reserved.backup_id &&
      uploading.copy_role === reserved.copy_role &&
      uploading.component === reserved.component &&
      uploading.chunk_index === reserved.chunk_index &&
      uploading.transport === reserved.transport &&
      uploading.provider === reserved.provider &&
      uploading.endpoint_alias === reserved.endpoint_alias &&
      uploading.object_key === reserved.object_key &&
      uploading.key_fingerprint === reserved.key_fingerprint &&
      uploading.endpoint_identity_fingerprint === reserved.endpoint_identity_fingerprint &&
      uploading.bucket === reserved.bucket &&
      uploading.region === reserved.region &&
      uploading.content_hmac_sha256 === reserved.content_hmac_sha256 &&
      uploading.ciphertext_sha256 === reserved.ciphertext_sha256 &&
      uploading.size_bytes === reserved.size_bytes &&
      uploading.provider_write_started &&
      (uploading.state === "uploading" ||
        uploading.state === "present" ||
        uploading.state === "verified");
    if (!markerMatchesReservation) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_LOCATOR_MISMATCH",
        "Durable backup write-start marker does not match the reserved object authority",
      );
    }

    // The storage boundary runs this fence after the durable write-start marker
    // and immediately before every bounded provider PUT attempt.
    const uploaded = await store.putImmutable({
      key: uploading.object_key,
      body,
      contentType: input.contentType,
      signal: input.signal,
      deadline: input.deadline,
      beforeWriteAttempt: input.revalidateLease,
      transferBodyOwnership: true,
    });
    requireLocatorMatchesObject(uploading, uploaded.locator);
    if (
      uploaded.metadata.sizeBytes !== uploading.size_bytes ||
      uploaded.metadata.checksum.algorithm !== "sha256" ||
      uploaded.metadata.checksum.encoding !== "base64" ||
      uploaded.metadata.checksum.value !== bodyDigestBase64
    ) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_METADATA_INVALID",
        "Provider upload receipt does not match the encrypted catalogue object",
      );
    }
    const uploadReceiptDigest = await sha256Canonical({
      version: 1,
      objectId: uploading.id,
      organizationId: uploading.organization_id,
      backupId: uploading.backup_id,
      copyRole: uploading.copy_role,
      endpointIdentityFingerprint: uploading.endpoint_identity_fingerprint,
      keyFingerprint: uploading.key_fingerprint,
      locator: uploaded.locator.toJSON(),
      sizeBytes: uploaded.metadata.sizeBytes,
      checksum: uploaded.metadata.checksum,
    });
    const version = providerReceiptFields(uploaded.locator);
    const present = await repository.recordPresent({
      organizationId: input.organizationId,
      objectId: uploading.id,
      ...version,
      providerChecksum: checksumIdentity(uploaded.metadata.checksum),
      uploadReceiptDigest,
      execution: input.execution,
    });
    return await repository.markVerified({
      organizationId: input.organizationId,
      objectId: present.id,
      uploadReceiptDigest,
      execution: input.execution,
    });
  } finally {
    body.fill(0);
    bodyDigest?.fill(0);
  }
}

/** Rebuild the exact private read locator from one verified catalogue row. */
export function storedAgentBackupObjectLocator(object: AgentBackupObject): {
  key: string;
  receipt: ObjectLocatorReceipt;
} {
  if (
    object.state !== "verified" ||
    !object.provider_write_started ||
    !object.upload_receipt_digest ||
    !/^[0-9a-f]{64}$/.test(object.upload_receipt_digest) ||
    !/^[0-9a-f]{64}$/.test(object.key_fingerprint)
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Exact backup read requires a verified persisted upload receipt",
    );
  }
  const receipt = storedObjectLocator(object);
  if (!receipt) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Verified backup object is missing its persisted provider generation",
    );
  }
  return { key: object.object_key, receipt };
}

/**
 * Drain a verified provider read into a fresh bounded buffer. Declared HEAD
 * metadata is not authority: the completion receipt must resolve after EOF.
 */
export async function readExactAgentBackupObjectToFreshBuffer(params: {
  read: ExactObjectRead;
  expectedSize: number;
}): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isSafeInteger(params.expectedSize) ||
    params.expectedSize < 0 ||
    params.expectedSize > MAX_IMMUTABLE_SINGLE_PUT_BYTES
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_UPLOAD_TOO_LARGE",
      "Secondary replication object exceeds the bounded immutable PUT limit",
    );
  }
  const completion = params.read.completion.then(
    (receipt) => ({ status: "fulfilled" as const, receipt }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  const bytes = new Uint8Array(new ArrayBuffer(params.expectedSize));
  const reader = params.read.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
        throw new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_READ_FAILED",
          "Exact backup read returned an invalid byte fragment",
        );
      }
      if (offset > bytes.byteLength - next.value.byteLength) {
        throw new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_READ_OVERFLOW",
          "Exact backup read exceeded its bounded replication buffer",
        );
      }
      bytes.set(next.value, offset);
      offset += next.value.byteLength;
    }
    const settledCompletion = await completion;
    if (settledCompletion.status === "rejected") throw settledCompletion.error;
    const { receipt } = settledCompletion;
    if (!receipt.verifiedComplete || offset !== bytes.byteLength) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_READ_TRUNCATED",
        "Exact backup read did not reach its verified byte length",
      );
    }
    return bytes;
  } catch (cause) {
    bytes.fill(0);
    try {
      await reader.cancel();
    } catch {
      // error-policy:J6 cancellation cannot replace the verified read failure.
    }
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

export interface ExecuteAgentBackupSecondaryObjectReplicationInput {
  organizationId: string;
  backupId: string;
  primaryObject: AgentBackupObject;
  secondaryEndpointAlias: string;
  /** Retained in the publication boundary; object keys are repository-owned. */
  scope: string;
  operationId: string;
  manifestDigest: string;
  registry: AgentBackupObjectStoreRegistry;
  execution: AgentBackupOperationExecution;
  revalidateLease(): Promise<void>;
  signal?: AbortSignal;
  deadline?: Date;
  uploadRepository?: AgentBackupObjectUploadRepository;
}

/** Replicate only from the persisted exact primary generation. */
export async function executeAgentBackupSecondaryObjectReplication(
  input: ExecuteAgentBackupSecondaryObjectReplicationInput,
): Promise<AgentBackupObject> {
  const primary = input.primaryObject;
  if (
    primary.organization_id !== input.organizationId ||
    primary.backup_id !== input.backupId ||
    primary.copy_role !== "primary" ||
    primary.provider !== "cloudflare-r2"
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_MISMATCH",
      "Secondary replication source does not match the persisted primary authority",
    );
  }
  if (primary.size_bytes > MAX_IMMUTABLE_SINGLE_PUT_BYTES) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_UPLOAD_TOO_LARGE",
      "Secondary replication requires a bounded single-PUT source object",
    );
  }
  const primaryStore = input.registry.forStoredObject(storedAgentBackupObjectAuthority(primary));
  requireStoreMatchesRole(primaryStore, "primary");
  const read = await primaryStore.getExactObject({
    locator: storedAgentBackupObjectLocator(primary),
    expectedSize: primary.size_bytes,
    expectedCipherSha256: primary.ciphertext_sha256,
    signal: input.signal,
    deadline: input.deadline,
  });
  const body = await readExactAgentBackupObjectToFreshBuffer({
    read,
    expectedSize: primary.size_bytes,
  });
  try {
    return await executeAgentBackupObjectUpload({
      organizationId: input.organizationId,
      backupId: input.backupId,
      copyRole: "secondary",
      component: primary.component,
      chunkIndex: primary.chunk_index,
      endpointAlias: input.secondaryEndpointAlias,
      contentHmacSha256: primary.content_hmac_sha256,
      ciphertextSha256: primary.ciphertext_sha256,
      execution: input.execution,
      registry: input.registry,
      body,
      contentType: "application/octet-stream",
      revalidateLease: input.revalidateLease,
      signal: input.signal,
      deadline: input.deadline,
      ...(input.uploadRepository ? { repository: input.uploadRepository } : {}),
    });
  } finally {
    body.fill(0);
  }
}

async function deletionReceiptDigest(
  claim: AgentBackupGcClaim,
  receipt: ObjectDeleteReceipt,
): Promise<string> {
  return sha256Canonical({
    version: 1,
    outboxId: claim.outbox.id,
    organizationId: claim.outbox.organization_id,
    objectId: claim.object.id,
    action: claim.outbox.action,
    endpointIdentityFingerprint: claim.object.endpoint_identity_fingerprint,
    keyFingerprint: claim.object.key_fingerprint,
    status: receipt.status,
    locator: receipt.locator.toJSON(),
    metadata: receipt.metadata,
    verifiedAbsent: receipt.verifiedAbsent,
  });
}

/** Execute one exact-key GC claim and atomically settle its provider receipt. */
export async function executeAgentBackupGcClaim(params: {
  claim: AgentBackupGcClaim;
  registry: AgentBackupObjectStoreRegistry;
  signal?: AbortSignal;
}): Promise<void> {
  const { claim } = params;
  const generation = claim.outbox.claim_generation;
  const ownerId = claim.outbox.claim_owner;
  if (!generation || !ownerId) {
    throw new Error("Claimed backup GC intent is missing its execution fence");
  }
  params.signal?.throwIfAborted();
  const leaseExpiresAt = claim.outbox.lease_expires_at;
  if (!(leaseExpiresAt instanceof Date) || !Number.isFinite(leaseExpiresAt.getTime())) {
    throw new Error("Claimed backup GC intent has no canonical lease expiry");
  }
  const control: ObjectRequestControl = {
    signal: params.signal,
    deadline: new Date(leaseExpiresAt.getTime() - GC_LEASE_SETTLEMENT_MARGIN_MS),
  };
  const store = params.registry.forStoredObject(storedAgentBackupObjectAuthority(claim.object));
  const resolved = await resolveGcDeletionLocator(store, claim, control);
  params.signal?.throwIfAborted();
  const receipt = await store.delete(
    {
      key: resolved.claim.object.object_key,
      locator: resolved.locator,
    },
    control,
  );
  params.signal?.throwIfAborted();
  requireLocatorMatchesObject(resolved.claim.object, receipt.locator);
  const receiptDigest = await deletionReceiptDigest(resolved.claim, receipt);
  params.signal?.throwIfAborted();
  await settleAgentBackupGc({
    outboxId: resolved.claim.outbox.id,
    ownerId,
    generation,
    receiptDigest,
  });
}

function boundedGcFailure(error: unknown): { code: string; message: string } {
  if (error instanceof ObjectStorageLifecycleError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "BACKUP_GC_PROVIDER_FAILURE",
    message: error instanceof Error ? error.message : "Backup GC provider operation failed",
  };
}

function isTerminalGcFailure(error: unknown): boolean {
  return (
    error instanceof ObjectStorageLifecycleError &&
    (error.code === "OBJECT_STORAGE_IMMUTABLE_CONFLICT" ||
      error.code === "OBJECT_STORAGE_METADATA_INVALID" ||
      error.code === "OBJECT_STORAGE_VERSION_MISMATCH")
  );
}

/**
 * Process independent claims without allowing one poison locator to starve the
 * remainder of the bounded batch. Failures retain the exact outbox row.
 */
export async function executeAgentBackupGcClaims(params: {
  claims: readonly AgentBackupGcClaim[];
  registry: AgentBackupObjectStoreRegistry;
  retryDelayMs: number;
  signal?: AbortSignal;
}): Promise<{ completed: number; failed: number }> {
  if (
    !Number.isSafeInteger(params.retryDelayMs) ||
    params.retryDelayMs < 1 ||
    params.retryDelayMs > MAX_GC_RETRY_DELAY_MS
  ) {
    throw new Error(`retryDelayMs must be between 1 and ${MAX_GC_RETRY_DELAY_MS}`);
  }
  let completed = 0;
  let failed = 0;
  for (const claim of params.claims) {
    params.signal?.throwIfAborted();
    try {
      await executeAgentBackupGcClaim({
        claim,
        registry: params.registry,
        signal: params.signal,
      });
      completed += 1;
    } catch (error) {
      params.signal?.throwIfAborted();
      // error-policy:J1 the durable worker boundary translates provider failure
      // into a retryable or terminal outbox receipt before continuing the batch.
      const ownerId = claim.outbox.claim_owner;
      const generation = claim.outbox.claim_generation;
      if (!ownerId || !generation) {
        failed += 1;
        continue;
      }
      try {
        const recovered = await failAgentBackupGc({
          outboxId: claim.outbox.id,
          ownerId,
          generation,
          error: boundedGcFailure(error),
          retryDelayMs: params.retryDelayMs,
          terminal: isTerminalGcFailure(error),
        });
        if (recovered.state === "completed") completed += 1;
        else failed += 1;
      } catch {
        // error-policy:J1 the claim may have expired or been reclaimed after
        // provider I/O. Its durable outbox remains authoritative; continue the
        // bounded batch so one lost lease cannot starve independent claims.
        failed += 1;
      }
    }
  }
  return { completed, failed };
}
