/**
 * Provider-backed execution boundary for the durable backup catalogue.
 *
 * Catalogue repositories own leases/CAS. This module is the only production
 * seam that turns an R2/Hetzner provider observation into a receipt digest.
 * Callers never provide an arbitrary successful receipt.
 */

import type { AgentBackupGcClaim } from "../../db/repositories/agent-backup-gc";
import {
  adoptAgentBackupGcObservedLocator,
  failAgentBackupGc,
  settleAgentBackupGc,
} from "../../db/repositories/agent-backup-gc";
import type { AgentBackupObject } from "../../db/schemas/agent-backup-catalog";
import type {
  AgentBackupObjectStore,
  AgentBackupObjectStoreRegistry,
  AgentBackupStorageAuthority,
} from "../storage/agent-backup-object-store";
import {
  type ObjectChecksumReceipt,
  type ObjectDeleteReceipt,
  type ObjectHeadReceipt,
  ObjectLocatorReceipt,
  ObjectStorageLifecycleError,
} from "../storage/object-store";

const MAX_GC_RETRY_DELAY_MS = 6 * 60 * 60 * 1_000;

async function sha256Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stableBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  stableBytes.set(bytes);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", stableBytes));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
  return bytesToBase64(bytes);
}

async function sha256Canonical(value: unknown): Promise<string> {
  return bytesToHex(await sha256Bytes(new TextEncoder().encode(JSON.stringify(value))));
}

function storedAuthority(object: AgentBackupObject): AgentBackupStorageAuthority {
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
  if (
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
): Promise<{ claim: AgentBackupGcClaim; locator: ObjectLocatorReceipt }> {
  const { object } = claim;
  const persisted = storedObjectLocator(object);
  if (persisted) return { claim, locator: persisted };

  const observed = await store.head(object.object_key);
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
}): Promise<void> {
  const { claim } = params;
  const generation = claim.outbox.claim_generation;
  const ownerId = claim.outbox.claim_owner;
  if (!generation || !ownerId) {
    throw new Error("Claimed backup GC intent is missing its execution fence");
  }
  const store = params.registry.forStoredObject(storedAuthority(claim.object));
  const resolved = await resolveGcDeletionLocator(store, claim);
  const receipt = await store.delete({
    key: resolved.claim.object.object_key,
    locator: resolved.locator,
  });
  requireLocatorMatchesObject(resolved.claim.object, receipt.locator);
  const receiptDigest = await deletionReceiptDigest(resolved.claim, receipt);
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
    try {
      await executeAgentBackupGcClaim({ claim, registry: params.registry });
      completed += 1;
    } catch (error) {
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
