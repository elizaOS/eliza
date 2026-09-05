/**
 * Decrypts one already-selected restore-v3 source object.
 *
 * This boundary deliberately owns neither copy selection nor failover. The
 * caller binds `openExactObject` to the selected immutable catalogue object.
 * Plaintext fragments are ephemeral and unauthenticated until the generator
 * finishes: consumers must copy them into isolated, rollbackable staging before
 * requesting the next fragment. A proof and source-object receipt are available
 * only as the generator's final return value, after the provider completion,
 * AES-GCM tag, ciphertext digest, content HMAC, and byte counts all agree.
 */

import { Buffer } from "node:buffer";
import { createDecipheriv, createHash, createHmac, type DecipherGCM } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_CHUNK_ENVELOPE_V1,
  AGENT_BACKUP_MANIFEST_V2_LIMITS,
  AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
  type AgentBackupManifestV3,
  type AgentBackupRestoreV3ExactReadReceiptProof,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3SourceAuthorityObject,
  AgentBackupRestoreV3SourceAuthorityObjectSchema,
  type AgentBackupRestoreV3SourceObjectReceipt,
  AgentBackupRestoreV3SourceObjectReceiptSchema,
  canonicalizeAgentBackupChunkAad,
  computeAgentBackupRestoreV3ExactReadReceiptSha256,
  parseAgentBackupRestoreV3ExactReadReceiptProof,
} from "@elizaos/shared";
import type {
  ExactObjectRead,
  ExactObjectReadReceipt,
  ObjectLocatorReceipt,
} from "../storage/object-store";
import {
  type AgentBackupRestoreV3Control,
  AgentBackupRestoreV3ControlError,
} from "./agent-backup-restore-v3-control";

const MAX_CRYPTO_FRAGMENT_BYTES = 256 * 1024;
const CANCEL_READER_DEADLINE_MS = 250;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type AgentBackupRestoreV3ExactObjectErrorCode =
  | "AGENT_BACKUP_RESTORE_V3_EXACT_OBJECT_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_EXACT_OBJECT_OPEN_FAILED"
  | "AGENT_BACKUP_RESTORE_V3_EXACT_READ_INVALID"
  | "AGENT_BACKUP_RESTORE_V3_EXACT_READ_FAILED"
  | "AGENT_BACKUP_RESTORE_V3_CIPHERTEXT_OVERFLOW"
  | "AGENT_BACKUP_RESTORE_V3_CIPHERTEXT_TRUNCATED"
  | "AGENT_BACKUP_RESTORE_V3_AAD_MISMATCH"
  | "AGENT_BACKUP_RESTORE_V3_NONCE_REUSE"
  | "AGENT_BACKUP_RESTORE_V3_AEAD_AUTHENTICATION_FAILED"
  | "AGENT_BACKUP_RESTORE_V3_PLAINTEXT_OVERFLOW"
  | "AGENT_BACKUP_RESTORE_V3_COMPLETION_FAILED"
  | "AGENT_BACKUP_RESTORE_V3_CHUNK_PROOF_MISMATCH"
  | "AGENT_BACKUP_RESTORE_V3_INGRESS_FRAGMENT_LIMIT_EXCEEDED"
  | "AGENT_BACKUP_RESTORE_V3_RECEIPT_INVALID";

export class AgentBackupRestoreV3ExactObjectError extends ElizaError {
  override readonly name = "AgentBackupRestoreV3ExactObjectError";

  constructor(
    code: AgentBackupRestoreV3ExactObjectErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, {
      code,
      cause: options?.cause,
      context: { subsystem: "agent-backup-restore-v3-exact-object" },
      severity: "fatal",
    });
  }
}

export interface StreamAgentBackupRestoreV3ExactObjectInput {
  /** A manifest already validated by the restore source-authority boundary. */
  readonly manifest: Readonly<AgentBackupManifestV3>;
  readonly backupId: string;
  readonly sourceAuthoritySha256: string;
  /** The exact copy and generation selected before entering this helper. */
  readonly sourceObject: Readonly<AgentBackupRestoreV3SourceAuthorityObject>;
  readonly openExactObject: (
    sourceObject: Readonly<AgentBackupRestoreV3SourceAuthorityObject>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ) => ExactObjectRead | Promise<ExactObjectRead>;
  /** Caller-owned operation keys. This helper never releases or retains them. */
  readonly dek: Uint8Array;
  readonly contentHmacKey: Uint8Array;
  /**
   * Shared by all objects decrypted with this operation key bundle. A
   * byte-identical retry of the same logical slot keeps its owner; reuse for a
   * different slot remains terminal.
   */
  readonly operationNonceOwners: Map<string, string>;
  /** Explicit caller cancellation and absolute deadline, owned by the kernel. */
  readonly control: AgentBackupRestoreV3Control;
}

export interface StreamAgentBackupRestoreV3ExactObjectResult {
  readonly proof: AgentBackupRestoreV3ExactReadReceiptProof;
  readonly receipt: AgentBackupRestoreV3SourceObjectReceipt;
}

function exactObjectError(
  code: AgentBackupRestoreV3ExactObjectErrorCode,
  message: string,
  cause?: unknown,
): AgentBackupRestoreV3ExactObjectError {
  return new AgentBackupRestoreV3ExactObjectError(code, message, { cause });
}

function fail(
  code: AgentBackupRestoreV3ExactObjectErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw exactObjectError(code, message, cause);
}

async function awaitControlled<T>(
  input: Readonly<StreamAgentBackupRestoreV3ExactObjectInput>,
  label: string,
  operation: () => T | PromiseLike<T>,
  onLateValue?: (
    value: T,
    cleanupControl: Readonly<AgentBackupRestoreV3OperationControl>,
  ) => void | PromiseLike<void>,
): Promise<T> {
  return input.control.wait(label, operation, onLateValue);
}

function requireInput(input: Readonly<StreamAgentBackupRestoreV3ExactObjectInput>): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.openExactObject !== "function" ||
    !(input.dek instanceof Uint8Array) ||
    input.dek.byteLength !== 32 ||
    !(input.contentHmacKey instanceof Uint8Array) ||
    input.contentHmacKey.byteLength !== 32 ||
    !(input.operationNonceOwners instanceof Map) ||
    !input.control ||
    typeof input.control !== "object" ||
    !(input.control.signal instanceof AbortSignal) ||
    !Number.isSafeInteger(input.control.deadlineEpochMs) ||
    typeof input.control.assertActive !== "function" ||
    typeof input.control.wait !== "function" ||
    typeof input.control.cleanup !== "function" ||
    !UUID_PATTERN.test(input.backupId) ||
    !SHA256_PATTERN.test(input.sourceAuthoritySha256)
  ) {
    fail(
      "AGENT_BACKUP_RESTORE_V3_EXACT_OBJECT_INVALID",
      "Exact restore object input is not canonical",
    );
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function ownedBytes(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes);
  return output;
}

interface PlaintextCoalescer {
  push(bytes: Uint8Array): Uint8Array | undefined;
  finish(): Uint8Array | undefined;
  wipe(): void;
}

function createPlaintextCoalescer(): PlaintextCoalescer {
  let buffer = new Uint8Array(MAX_CRYPTO_FRAGMENT_BYTES);
  let length = 0;
  return {
    push(bytes) {
      let offset = 0;
      let complete: Uint8Array | undefined;
      while (offset < bytes.byteLength) {
        const take = Math.min(bytes.byteLength - offset, buffer.byteLength - length);
        buffer.set(bytes.subarray(offset, offset + take), length);
        offset += take;
        length += take;
        if (length === buffer.byteLength) {
          complete = buffer;
          buffer = new Uint8Array(MAX_CRYPTO_FRAGMENT_BYTES);
          length = 0;
        }
      }
      return complete;
    },
    finish() {
      if (length === 0) return undefined;
      const remainder = buffer.subarray(0, length);
      buffer = new Uint8Array(MAX_CRYPTO_FRAGMENT_BYTES);
      length = 0;
      return remainder;
    },
    wipe() {
      buffer.fill(0);
      length = 0;
    },
  };
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function operationNonceOwner(
  operationId: string,
  sourceObject: Readonly<AgentBackupRestoreV3SourceAuthorityObject>,
): string {
  return JSON.stringify({
    operationId,
    componentIndex: sourceObject.componentIndex,
    componentName: sourceObject.componentName,
    chunkIndex: sourceObject.chunkIndex,
    ciphertextSha256: sourceObject.catalog.ciphertextSha256,
  });
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fingerprint(value: string): `sha256:${string}` {
  return `sha256:${sha256Hex(value)}`;
}

function expectedCipherSha256Base64(ciphertextSha256: string): string {
  return Buffer.from(ciphertextSha256, "hex").toString("base64");
}

async function discardLateExactRead(
  value: unknown,
  _cleanupControl: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<void> {
  if (!value || typeof value !== "object") return;
  try {
    const completion = (value as { completion?: unknown }).completion;
    if (
      completion &&
      (typeof completion === "object" || typeof completion === "function") &&
      typeof (completion as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(completion).catch((_failure: unknown) => undefined);
    }
  } catch (_failure: unknown) {
    // error-policy:J6 malformed late collaborators are already outside authority.
  }
  const body = (value as { body?: unknown }).body;
  if (body instanceof ReadableStream) {
    // error-policy:J5 cancellation settlement is returned to the fresh cleanup
    // control so a hanging or rejecting provider cannot escape observation.
    await body.cancel();
  }
}

async function discardInvalidExactRead(
  input: Readonly<StreamAgentBackupRestoreV3ExactObjectInput>,
  value: unknown,
): Promise<void> {
  try {
    await input.control.cleanup(
      "Invalid exact restore object cleanup",
      (cleanupControl) => discardLateExactRead(value, cleanupControl),
      CANCEL_READER_DEADLINE_MS,
    );
  } catch (_failure: unknown) {
    // error-policy:J6 invalid collaborator cleanup is bounded and best-effort.
  }
}

async function cancelReaderBounded(
  control: AgentBackupRestoreV3Control,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await control.cleanup(
      "Exact restore object reader cancellation",
      () => reader.cancel(),
      CANCEL_READER_DEADLINE_MS,
    );
  } catch (_failure: unknown) {
    // error-policy:J6 cancellation is best-effort after restore staging fails.
  }
}

function exactReadShapeMatches(
  read: unknown,
  sizeBytes: number,
  ciphertextSha256: string,
): read is ExactObjectRead {
  if (!read || typeof read !== "object") return false;
  try {
    const candidate = read as Partial<ExactObjectRead>;
    const checksum = candidate.declaredMetadata?.checksum;
    return (
      candidate.body instanceof ReadableStream &&
      candidate.completion !== undefined &&
      typeof (candidate.completion as PromiseLike<unknown>).then === "function" &&
      candidate.declaredMetadata?.sizeBytes === sizeBytes &&
      checksum?.algorithm === "sha256" &&
      checksum.encoding === "base64" &&
      checksum.value === expectedCipherSha256Base64(ciphertextSha256)
    );
  } catch (_failure: unknown) {
    // error-policy:J3 an untrusted provider read shape must fail closed.
    return false;
  }
}

function expectedVersion(sourceObject: Readonly<AgentBackupRestoreV3SourceAuthorityObject>): {
  version: string;
  source: "provider" | "etag" | "checksum";
} {
  const catalog = sourceObject.catalog;
  if (catalog.providerVersionId !== null) {
    return { version: catalog.providerVersionId, source: "provider" };
  }
  if (catalog.providerEtag !== null) {
    return { version: catalog.providerEtag, source: "etag" };
  }
  if (catalog.providerChecksum !== null) {
    return {
      version: catalog.providerChecksum.slice("sha256:base64:".length),
      source: "checksum",
    };
  }
  fail(
    "AGENT_BACKUP_RESTORE_V3_EXACT_OBJECT_INVALID",
    "Exact restore object lacks immutable provider generation authority",
  );
}

function completionMatches(
  sourceObject: Readonly<AgentBackupRestoreV3SourceAuthorityObject>,
  completion: unknown,
  ciphertextSha256: string,
): completion is ExactObjectReadReceipt {
  if (!completion || typeof completion !== "object") return false;
  try {
    const candidate = completion as ExactObjectReadReceipt;
    const catalog = sourceObject.catalog;
    const version = expectedVersion(sourceObject);
    const expectedTransport =
      catalog.transport === "worker-r2" ? "worker-r2-binding" : "s3-compatible";
    const expectedProvider = catalog.provider === "cloudflare-r2" ? "r2" : "s3";
    const locator = candidate.locator;
    return (
      candidate.verifiedComplete === true &&
      candidate.metadata.sizeBytes === catalog.sizeBytes &&
      candidate.metadata.checksum.algorithm === "sha256" &&
      candidate.metadata.checksum.encoding === "base64" &&
      candidate.metadata.checksum.value === expectedCipherSha256Base64(ciphertextSha256) &&
      locator.transport === expectedTransport &&
      locator.provider === expectedProvider &&
      locator.backendIdentityFingerprint === catalog.endpointIdentityFingerprint &&
      fingerprint(locator.endpointAlias) === catalog.endpointAliasFingerprint &&
      fingerprint(locator.bucket) === catalog.bucketFingerprint &&
      fingerprint(locator.region) === catalog.regionFingerprint &&
      locator.keyFingerprint === catalog.keyFingerprint &&
      locator.version === version.version &&
      locator.versionSource === version.source
    );
  } catch (_failure: unknown) {
    // error-policy:J3 an untrusted completion shape must fail closed.
    return false;
  }
}

function completionProof(
  identity: Readonly<{
    organizationId: string;
    backupId: string;
    sourceAuthoritySha256: string;
  }>,
  sourceObject: Readonly<AgentBackupRestoreV3SourceAuthorityObject>,
  locator: ObjectLocatorReceipt,
): AgentBackupRestoreV3ExactReadReceiptProof {
  return parseAgentBackupRestoreV3ExactReadReceiptProof({
    derivation: AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
    sourceAuthoritySha256: identity.sourceAuthoritySha256,
    organizationId: identity.organizationId,
    backupId: identity.backupId,
    objectId: sourceObject.objectId,
    componentIndex: sourceObject.componentIndex,
    componentName: sourceObject.componentName,
    chunkIndex: sourceObject.chunkIndex,
    copyRole: sourceObject.copyRole,
    catalog: sourceObject.catalog,
    completion: {
      transport: locator.transport,
      provider: locator.provider,
      backendIdentityFingerprint: locator.backendIdentityFingerprint,
      endpointAliasFingerprint: fingerprint(locator.endpointAlias),
      bucketFingerprint: fingerprint(locator.bucket),
      regionFingerprint: fingerprint(locator.region),
      keyFingerprint: locator.keyFingerprint,
      version: locator.version,
      versionSource: locator.versionSource,
      sizeBytes: sourceObject.catalog.sizeBytes,
      checksumSha256Base64: expectedCipherSha256Base64(sourceObject.catalog.ciphertextSha256),
      ciphertextSha256: sourceObject.catalog.ciphertextSha256,
      verifiedComplete: true,
    },
  });
}

function validateAndResolveSlot(input: Readonly<StreamAgentBackupRestoreV3ExactObjectInput>): {
  sourceObject: AgentBackupRestoreV3SourceAuthorityObject;
  chunk: AgentBackupManifestV3["components"][number]["chunks"][number];
  organizationId: string;
  operationId: string;
  aad: Uint8Array;
} {
  let sourceObject: AgentBackupRestoreV3SourceAuthorityObject;
  try {
    sourceObject = freezeDeep(
      AgentBackupRestoreV3SourceAuthorityObjectSchema.parse(input.sourceObject),
    );
  } catch (cause) {
    // error-policy:J3 source authority is persisted untrusted input and must
    // become one structured invalid-authority failure.
    fail(
      "AGENT_BACKUP_RESTORE_V3_EXACT_OBJECT_INVALID",
      "Exact restore source object authority is invalid",
      cause,
    );
  }
  const component = input.manifest.components[sourceObject.componentIndex];
  const chunk = component?.chunks[sourceObject.chunkIndex];
  if (
    input.manifest.schemaVersion !== 3 ||
    input.manifest.identity.organizationId.length === 0 ||
    !component ||
    component.name !== sourceObject.componentName ||
    component.compression !== "none" ||
    !chunk ||
    chunk.index !== sourceObject.chunkIndex ||
    chunk.contentHmacSha256 !== sourceObject.contentHmacSha256 ||
    chunk.sha256 !== sourceObject.catalog.ciphertextSha256 ||
    chunk.encryptedBytes !== sourceObject.catalog.sizeBytes ||
    (sourceObject.catalog.providerChecksum !== null &&
      sourceObject.catalog.providerChecksum !==
        `sha256:base64:${expectedCipherSha256Base64(sourceObject.catalog.ciphertextSha256)}`) ||
    chunk.encryptedBytes !==
      chunk.compressedBytes +
        AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes +
        AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes ||
    chunk.compressedBytes !== chunk.plainBytes
  ) {
    fail(
      "AGENT_BACKUP_RESTORE_V3_EXACT_OBJECT_INVALID",
      "Exact restore source object differs from its manifest-v3 chunk",
    );
  }
  const aad = new TextEncoder().encode(
    canonicalizeAgentBackupChunkAad({
      identity: input.manifest.identity,
      operationId: input.manifest.operationId,
      component: {
        name: component.name,
        format: component.format,
        compression: component.compression,
      },
      chunk: {
        index: chunk.index,
        offsetBytes: chunk.offsetBytes,
        plainBytes: chunk.plainBytes,
        compressedBytes: chunk.compressedBytes,
        contentHmacSha256: chunk.contentHmacSha256,
      },
    }),
  );
  if (sha256Hex(aad) !== chunk.aadSha256) {
    aad.fill(0);
    fail(
      "AGENT_BACKUP_RESTORE_V3_AAD_MISMATCH",
      "Canonical manifest-v3 AAD differs from the selected chunk",
    );
  }
  return {
    sourceObject,
    chunk: Object.freeze({ ...chunk }),
    organizationId: input.manifest.identity.organizationId,
    operationId: input.manifest.operationId,
    aad,
  };
}

/**
 * Stream one selected immutable object into isolated restore staging.
 *
 * The returned generator value is the only success signal. Calling `return()`
 * before `done: true` cancels the provider reader and cannot yield a receipt.
 */
export async function* streamAgentBackupRestoreV3ExactObject(
  input: Readonly<StreamAgentBackupRestoreV3ExactObjectInput>,
): AsyncGenerator<Uint8Array, StreamAgentBackupRestoreV3ExactObjectResult, void> {
  requireInput(input);
  input.control.assertActive("Exact restore object");
  const { sourceObject, chunk, organizationId, operationId, aad } = validateAndResolveSlot(input);
  const receiptIdentity = Object.freeze({
    organizationId,
    backupId: input.backupId,
    sourceAuthoritySha256: input.sourceAuthoritySha256,
  });
  const control = Object.freeze({
    signal: input.control.signal,
    deadlineEpochMs: input.control.deadlineEpochMs,
  });
  let read: ExactObjectRead;
  try {
    read = await awaitControlled(
      input,
      "Exact restore object open",
      () => input.openExactObject(sourceObject, control),
      discardLateExactRead,
    );
  } catch (cause) {
    aad.fill(0);
    if (
      cause instanceof AgentBackupRestoreV3ExactObjectError ||
      cause instanceof AgentBackupRestoreV3ControlError
    ) {
      throw cause;
    }
    // error-policy:J2 preserve the provider open failure behind a bounded
    // restore-v3 error without exposing its locator in the public message.
    fail(
      "AGENT_BACKUP_RESTORE_V3_EXACT_OBJECT_OPEN_FAILED",
      "Opening the exact restore object failed",
      cause,
    );
  }
  if (
    !exactReadShapeMatches(
      read,
      sourceObject.catalog.sizeBytes,
      sourceObject.catalog.ciphertextSha256,
    )
  ) {
    aad.fill(0);
    await discardInvalidExactRead(input, read);
    fail(
      "AGENT_BACKUP_RESTORE_V3_EXACT_READ_INVALID",
      "Exact object read declared different ciphertext authority",
    );
  }
  const completionPromise = Promise.resolve(read.completion);
  // error-policy:J5 completion can reject before body drain reaches it.
  void completionPromise.catch((_failure: unknown) => undefined);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = read.body.getReader();
  } catch (cause) {
    aad.fill(0);
    await discardInvalidExactRead(input, read);
    // error-policy:J2 a locked or malformed provider stream is translated at
    // this exact-read boundary and the original cause remains attached.
    fail(
      "AGENT_BACKUP_RESTORE_V3_EXACT_READ_INVALID",
      "Exact object body is already locked",
      cause,
    );
  }

  const nonce = new Uint8Array(AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes);
  const tag = new Uint8Array(AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes);
  const encryptedHash = createHash("sha256");
  const contentHmac = createHmac("sha256", input.contentHmacKey);
  const plaintextCoalescer = createPlaintextCoalescer();
  const tagStart = chunk.encryptedBytes - tag.byteLength;
  let encryptedOffset = 0;
  let ingressFragmentCount = 0;
  let plaintextBytes = 0;
  let decipher: DecipherGCM | undefined;
  let bodyComplete = false;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await awaitControlled(
          input,
          "Exact restore object read",
          () => reader.read(),
          (late) => {
            if (!late.done && late.value instanceof Uint8Array) late.value.fill(0);
          },
        );
      } catch (cause) {
        if (
          cause instanceof AgentBackupRestoreV3ExactObjectError ||
          cause instanceof AgentBackupRestoreV3ControlError
        ) {
          throw cause;
        }
        // error-policy:J2 preserve provider read failure as a structured exact
        // restore error while the outer finally owns bounded cancellation.
        fail(
          "AGENT_BACKUP_RESTORE_V3_EXACT_READ_FAILED",
          "Reading the exact restore object failed",
          cause,
        );
      }
      if (next.done) {
        bodyComplete = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) {
        fail(
          "AGENT_BACKUP_RESTORE_V3_EXACT_READ_INVALID",
          "Exact object body yielded an invalid byte fragment",
        );
      }
      ingressFragmentCount += 1;
      if (ingressFragmentCount > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxPlaintextFragmentsPerChunk) {
        fail(
          "AGENT_BACKUP_RESTORE_V3_INGRESS_FRAGMENT_LIMIT_EXCEEDED",
          "Exact object body exceeded its bounded ingress fragment count",
        );
      }
      const ingress = next.value;
      try {
        if (ingress.byteLength === 0) continue;
        if (encryptedOffset + ingress.byteLength > chunk.encryptedBytes) {
          fail(
            "AGENT_BACKUP_RESTORE_V3_CIPHERTEXT_OVERFLOW",
            "Exact object body exceeds its manifest-v3 byte length",
          );
        }
        let ingressOffset = 0;
        while (ingressOffset < ingress.byteLength) {
          input.control.assertActive("Exact restore object decrypt");
          const absolute = encryptedOffset + ingressOffset;
          const regionEnd =
            absolute < nonce.byteLength
              ? nonce.byteLength
              : absolute < tagStart
                ? tagStart
                : chunk.encryptedBytes;
          const take = Math.min(
            ingress.byteLength - ingressOffset,
            regionEnd - absolute,
            MAX_CRYPTO_FRAGMENT_BYTES,
          );
          if (take <= 0) {
            fail(
              "AGENT_BACKUP_RESTORE_V3_CIPHERTEXT_OVERFLOW",
              "Exact object body crossed its manifest-v3 envelope",
            );
          }
          const fragment = ingress.subarray(ingressOffset, ingressOffset + take);
          encryptedHash.update(fragment);
          if (absolute < nonce.byteLength) {
            nonce.set(fragment, absolute);
            if (absolute + take === nonce.byteLength) {
              const nonceHex = bytesToHex(nonce);
              const owner = operationNonceOwner(operationId, sourceObject);
              const priorOwner = input.operationNonceOwners.get(nonceHex);
              if (priorOwner !== undefined && priorOwner !== owner) {
                fail(
                  "AGENT_BACKUP_RESTORE_V3_NONCE_REUSE",
                  "AES-GCM nonce was reused within one restore operation",
                );
              }
              input.operationNonceOwners.set(nonceHex, owner);
              decipher = createDecipheriv("aes-256-gcm", input.dek, nonce, {
                authTagLength: tag.byteLength,
              });
              decipher.setAAD(aad);
            }
          } else if (absolute < tagStart) {
            if (!decipher) {
              fail(
                "AGENT_BACKUP_RESTORE_V3_EXACT_READ_INVALID",
                "Ciphertext arrived before a complete AES-GCM nonce",
              );
            }
            const decipherOutput = decipher.update(fragment);
            const plaintext = ownedBytes(decipherOutput);
            decipherOutput.fill(0);
            let completePlaintext: Uint8Array | undefined;
            if (plaintext.byteLength > 0) {
              try {
                plaintextBytes += plaintext.byteLength;
                if (
                  plaintext.byteLength > MAX_CRYPTO_FRAGMENT_BYTES ||
                  plaintextBytes > chunk.plainBytes
                ) {
                  fail(
                    "AGENT_BACKUP_RESTORE_V3_PLAINTEXT_OVERFLOW",
                    "Decrypted object exceeds its manifest-v3 byte length",
                  );
                }
                contentHmac.update(plaintext);
                completePlaintext = plaintextCoalescer.push(plaintext);
              } finally {
                plaintext.fill(0);
              }
            }
            if (completePlaintext) {
              input.control.assertActive("Exact restore object plaintext");
              try {
                yield completePlaintext;
              } finally {
                completePlaintext.fill(0);
              }
            }
          } else {
            tag.set(fragment, absolute - tagStart);
          }
          ingressOffset += take;
        }
        encryptedOffset += ingress.byteLength;
      } finally {
        ingress.fill(0);
      }
    }

    if (encryptedOffset !== chunk.encryptedBytes || !decipher) {
      fail(
        "AGENT_BACKUP_RESTORE_V3_CIPHERTEXT_TRUNCATED",
        "Exact object body ended outside its manifest-v3 envelope",
      );
    }
    decipher.setAuthTag(tag);
    let final: Uint8Array;
    try {
      const decipherOutput = decipher.final();
      final = ownedBytes(decipherOutput);
      decipherOutput.fill(0);
    } catch (cause) {
      // error-policy:J2 AES-GCM authentication failure is a terminal structured
      // restore error; the crypto cause remains attached for diagnostics.
      fail(
        "AGENT_BACKUP_RESTORE_V3_AEAD_AUTHENTICATION_FAILED",
        "AES-GCM authentication failed for the exact restore object",
        cause,
      );
    }
    if (final.byteLength > 0) {
      let completePlaintext: Uint8Array | undefined;
      try {
        plaintextBytes += final.byteLength;
        if (final.byteLength > MAX_CRYPTO_FRAGMENT_BYTES || plaintextBytes > chunk.plainBytes) {
          fail(
            "AGENT_BACKUP_RESTORE_V3_PLAINTEXT_OVERFLOW",
            "Authenticated AES-GCM tail exceeds its manifest-v3 byte length",
          );
        }
        contentHmac.update(final);
        completePlaintext = plaintextCoalescer.push(final);
      } finally {
        final.fill(0);
      }
      if (completePlaintext) {
        input.control.assertActive("Exact restore object plaintext");
        try {
          yield completePlaintext;
        } finally {
          completePlaintext.fill(0);
        }
      }
    }
    const remainingPlaintext = plaintextCoalescer.finish();
    if (remainingPlaintext) {
      input.control.assertActive("Exact restore object plaintext");
      try {
        yield remainingPlaintext;
      } finally {
        remainingPlaintext.fill(0);
      }
    }

    let completion: ExactObjectReadReceipt;
    try {
      completion = await awaitControlled(
        input,
        "Exact restore object completion",
        () => completionPromise,
      );
    } catch (cause) {
      if (
        cause instanceof AgentBackupRestoreV3ExactObjectError ||
        cause instanceof AgentBackupRestoreV3ControlError
      ) {
        throw cause;
      }
      // error-policy:J2 provider completion rejection is translated without
      // weakening the exact-generation proof requirement.
      fail(
        "AGENT_BACKUP_RESTORE_V3_COMPLETION_FAILED",
        "Exact object completion proof failed",
        cause,
      );
    }
    const actualCiphertextSha256 = encryptedHash.digest("hex");
    const actualContentHmacSha256 = contentHmac.digest("hex");
    if (
      !completionMatches(sourceObject, completion, sourceObject.catalog.ciphertextSha256) ||
      actualCiphertextSha256 !== sourceObject.catalog.ciphertextSha256 ||
      plaintextBytes !== chunk.plainBytes ||
      actualContentHmacSha256 !== sourceObject.contentHmacSha256
    ) {
      fail(
        "AGENT_BACKUP_RESTORE_V3_CHUNK_PROOF_MISMATCH",
        "Authenticated object proof differs from manifest-v3 authority",
      );
    }
    let proof: AgentBackupRestoreV3ExactReadReceiptProof;
    try {
      proof = completionProof(receiptIdentity, sourceObject, completion.locator);
    } catch (cause) {
      if (
        cause instanceof AgentBackupRestoreV3ExactObjectError ||
        cause instanceof AgentBackupRestoreV3ControlError
      ) {
        throw cause;
      }
      // error-policy:J3 proof parsing may contain private locator values in its
      // rejected input, so expose only a stable locator-free terminal error.
      fail(
        "AGENT_BACKUP_RESTORE_V3_CHUNK_PROOF_MISMATCH",
        "Exact object completion could not form a canonical locator-free proof",
      );
    }
    let exactReadReceiptSha256: string;
    try {
      exactReadReceiptSha256 = await awaitControlled(
        input,
        "Exact restore object receipt digest",
        () => computeAgentBackupRestoreV3ExactReadReceiptSha256(proof),
      );
    } catch (cause) {
      if (
        cause instanceof AgentBackupRestoreV3ExactObjectError ||
        cause instanceof AgentBackupRestoreV3ControlError
      ) {
        throw cause;
      }
      // error-policy:J2 the proof is already locator-free and canonical, so its
      // digest failure may retain the original diagnostic cause.
      fail(
        "AGENT_BACKUP_RESTORE_V3_RECEIPT_INVALID",
        "Exact object receipt digest could not be computed",
        cause,
      );
    }
    let receipt: AgentBackupRestoreV3SourceObjectReceipt;
    try {
      receipt = Object.freeze(
        AgentBackupRestoreV3SourceObjectReceiptSchema.parse({
          componentIndex: sourceObject.componentIndex,
          componentName: sourceObject.componentName,
          chunkIndex: sourceObject.chunkIndex,
          copyRole: sourceObject.copyRole,
          objectId: sourceObject.objectId,
          exactReadReceiptDerivation: AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
          exactReadReceiptSha256,
          ciphertextSha256: sourceObject.catalog.ciphertextSha256,
          sizeBytes: sourceObject.catalog.sizeBytes,
        }),
      );
    } catch (cause) {
      // error-policy:J2 receipt fields are locator-free; retain the schema cause
      // behind a stable terminal receipt error.
      fail(
        "AGENT_BACKUP_RESTORE_V3_RECEIPT_INVALID",
        "Exact object source receipt is invalid",
        cause,
      );
    }
    return Object.freeze({ proof, receipt });
  } finally {
    plaintextCoalescer.wipe();
    decipher?.destroy();
    contentHmac.destroy();
    encryptedHash.destroy();
    nonce.fill(0);
    tag.fill(0);
    aad.fill(0);
    if (!bodyComplete) await cancelReaderBounded(input.control, reader);
    try {
      reader.releaseLock();
    } catch (_failure: unknown) {
      // error-policy:J6 cancellation may still own a non-cooperative reader.
    }
  }
}
