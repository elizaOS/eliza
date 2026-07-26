/**
 * Bounded encrypted object storage for v2 agent backup streams.
 *
 * Producers may emit arbitrarily sized byte views, but this boundary retains
 * only one fixed-size plaintext chunk and one ciphertext chunk at a time. Each
 * object is independently authenticated to its tenant, sandbox, backup,
 * protocol version, index, and plaintext size. The returned descriptor is
 * complete only after every object is durable; callers commit it atomically
 * with the backup row before making the restore point visible.
 */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { orgKey } from "@elizaos/security/kms";
import { getKmsClient } from "../../db/crypto/kms-client";
import { ObjectNamespaces } from "../storage/object-namespace";
import {
  buildObjectKey,
  deleteObject,
  getObjectBytes,
  putObjectBytes,
} from "../storage/object-store";

const textEncoder = new TextEncoder();
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_COUNT = 512;
const MAX_TOTAL_BYTES = DEFAULT_CHUNK_BYTES * MAX_CHUNK_COUNT;
const CHUNK_CONTENT_TYPE = "application/vnd.elizaos.agent-backup-chunk";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AgentBackupEncryptedChunk {
  index: number;
  objectKey: string;
  plaintextBytes: number;
  ciphertextBytes: number;
  plaintextSha256: string;
  ciphertextSha256: string;
  nonceBase64: string;
  authTagBase64: string;
  kmsKeyId: string;
  kmsKeyVersion: number;
}

export interface AgentBackupChunkDescriptor {
  format: "elizaos.agent-backup-chunks";
  descriptorVersion: 1;
  backupSchemaVersion: 2;
  commitState: "complete";
  organizationId: string;
  sandboxRecordId: string;
  backupId: string;
  objectSetId: string;
  createdAt: string;
  chunkBytes: number;
  totalPlaintextBytes: number;
  totalPlaintextSha256: string;
  chunks: AgentBackupEncryptedChunk[];
}

export interface AgentBackupChunkIdentity {
  organizationId: string;
  sandboxRecordId: string;
  backupId: string;
  backupSchemaVersion: 2;
}

export interface AgentBackupPlannedChunk {
  index: number;
  objectKey: string;
}

function backupChunkError(code: string, message: string, context?: Record<string, unknown>) {
  return new ElizaError(message, {
    code,
    context,
    severity: "fatal",
  });
}

function assertPositiveInteger(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
      `${name} must be an integer between 1 and ${max}`,
      { [name]: value },
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string, field: string, expectedBytes: number): Uint8Array {
  const expectedEncodedLength = Math.ceil(expectedBytes / 3) * 4;
  if (
    typeof value !== "string" ||
    value.length !== expectedEncodedLength ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
      `${field} is not canonical base64`,
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
      `${field} is not canonical base64`,
    );
  }
  if (decoded.byteLength !== expectedBytes) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
      `${field} must decode to exactly ${expectedBytes} bytes`,
    );
  }
  return new Uint8Array(decoded);
}

function chunkAad(identity: AgentBackupChunkIdentity, index: number, plaintextBytes: number) {
  return textEncoder.encode(
    [
      "agent-sandbox-backup-chunk",
      identity.organizationId,
      identity.sandboxRecordId,
      identity.backupId,
      identity.backupSchemaVersion,
      index,
      plaintextBytes,
    ].join("|"),
  );
}

async function* fixedChunks(
  source: AsyncIterable<Uint8Array>,
  chunkBytes: number,
): AsyncGenerator<Uint8Array> {
  let target = new Uint8Array(chunkBytes);
  let used = 0;
  for await (const input of source) {
    if (!(input instanceof Uint8Array)) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_SOURCE_INVALID",
        "Backup byte stream emitted a non-Uint8Array value",
      );
    }
    if (input.byteLength > MAX_CHUNK_BYTES) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_SOURCE_INVALID",
        `Backup byte stream emitted a view larger than ${MAX_CHUNK_BYTES} bytes`,
        { emittedBytes: input.byteLength },
      );
    }
    let offset = 0;
    while (offset < input.byteLength) {
      const copied = Math.min(chunkBytes - used, input.byteLength - offset);
      target.set(input.subarray(offset, offset + copied), used);
      offset += copied;
      used += copied;
      if (used === chunkBytes) {
        yield target;
        used = 0;
      }
    }
  }
  if (used > 0) yield target.subarray(0, used);
}

function validateIdentity(identity: AgentBackupChunkIdentity): void {
  if (!identity || typeof identity !== "object") {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_IDENTITY_INVALID",
      "Backup chunk identity must be an object",
    );
  }
  for (const name of ["organizationId", "sandboxRecordId", "backupId"] as const) {
    const value = identity[name];
    if (typeof value !== "string" || !UUID_RE.test(value)) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_IDENTITY_INVALID",
        `${name} must be a canonical UUID`,
      );
    }
  }
  if (identity.backupSchemaVersion !== 2) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_IDENTITY_INVALID",
      "Chunked backups require backup schema version 2",
    );
  }
}

function canonicalCreatedAt(value: string): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return null;
  return date;
}

function chunkObjectParams(params: {
  identity: AgentBackupChunkIdentity;
  objectSetId: string;
  createdAt: Date;
  index: number;
}) {
  return {
    namespace: ObjectNamespaces.AgentSandboxBackups,
    organizationId: params.identity.organizationId,
    objectId: `${params.identity.backupId}.${params.objectSetId}`,
    field: `chunk-${String(params.index).padStart(6, "0")}`,
    createdAt: params.createdAt,
  } as const;
}

export async function stageEncryptedAgentBackupChunks(params: {
  identity: AgentBackupChunkIdentity;
  source: AsyncIterable<Uint8Array>;
  createdAt?: Date;
  chunkBytes?: number;
  maxTotalBytes?: number;
  onObjectPlanned?: (planned: AgentBackupPlannedChunk) => Promise<void>;
}): Promise<AgentBackupChunkDescriptor> {
  validateIdentity(params.identity);
  const chunkBytes = params.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const maxTotalBytes = params.maxTotalBytes ?? MAX_TOTAL_BYTES;
  assertPositiveInteger(chunkBytes, "chunkBytes", MAX_CHUNK_BYTES);
  assertPositiveInteger(maxTotalBytes, "maxTotalBytes", MAX_TOTAL_BYTES);

  const createdAt = params.createdAt ?? new Date();
  if (!Number.isFinite(createdAt.getTime())) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
      "Backup chunk creation time must be a valid Date",
    );
  }
  const objectSetId = randomUUID();
  const kms = getKmsClient();
  const keyId = orgKey(params.identity.organizationId, "dek");
  await kms.getOrCreateKey(keyId);
  const totalHash = createHash("sha256");
  const chunks: AgentBackupEncryptedChunk[] = [];
  const uploadedKeys: string[] = [];
  let totalPlaintextBytes = 0;

  try {
    for await (const plaintext of fixedChunks(params.source, chunkBytes)) {
      const index = chunks.length;
      if (index >= MAX_CHUNK_COUNT) {
        throw backupChunkError(
          "AGENT_BACKUP_CHUNK_LIMIT_EXCEEDED",
          `Backup exceeds the ${MAX_CHUNK_COUNT}-chunk limit`,
        );
      }
      totalPlaintextBytes += plaintext.byteLength;
      if (totalPlaintextBytes > maxTotalBytes) {
        throw backupChunkError(
          "AGENT_BACKUP_CHUNK_BUDGET_EXCEEDED",
          `Backup exceeds its ${maxTotalBytes}-byte plaintext budget`,
          { totalPlaintextBytes },
        );
      }
      totalHash.update(plaintext);
      const encrypted = await kms.encrypt(
        keyId,
        plaintext,
        chunkAad(params.identity, index, plaintext.byteLength),
      );
      const ciphertext = new Uint8Array(encrypted.ciphertext);
      if (
        encrypted.keyId !== keyId ||
        !Number.isSafeInteger(encrypted.keyVersion) ||
        encrypted.keyVersion < 1 ||
        encrypted.nonce.byteLength !== NONCE_BYTES ||
        encrypted.authTag.byteLength !== AUTH_TAG_BYTES ||
        ciphertext.byteLength !== plaintext.byteLength
      ) {
        throw backupChunkError(
          "AGENT_BACKUP_CHUNK_ENCRYPTION_INVALID",
          "KMS returned metadata that is incompatible with the chunk protocol",
        );
      }
      const objectParams = chunkObjectParams({
        identity: params.identity,
        objectSetId,
        createdAt,
        index,
      });
      const expectedObjectKey = buildObjectKey({ ...objectParams, extension: "bin" });
      // error-policy:J6 best-effort teardown — track the intended key before
      // PUT because a transport error can occur after object storage commits.
      uploadedKeys.push(expectedObjectKey);
      await params.onObjectPlanned?.({ index, objectKey: expectedObjectKey });
      const objectKey = await putObjectBytes({
        ...objectParams,
        body: ciphertext,
        contentType: CHUNK_CONTENT_TYPE,
      });
      if (objectKey !== expectedObjectKey) {
        uploadedKeys.push(objectKey);
        throw backupChunkError(
          "AGENT_BACKUP_CHUNK_OBJECT_KEY_INVALID",
          "Object storage returned a key outside the staged backup object set",
        );
      }
      chunks.push({
        index,
        objectKey,
        plaintextBytes: plaintext.byteLength,
        ciphertextBytes: ciphertext.byteLength,
        plaintextSha256: sha256(plaintext),
        ciphertextSha256: sha256(ciphertext),
        nonceBase64: toBase64(encrypted.nonce),
        authTagBase64: toBase64(encrypted.authTag),
        kmsKeyId: encrypted.keyId,
        kmsKeyVersion: encrypted.keyVersion,
      });
    }
  } catch (error) {
    // error-policy:J6 best-effort teardown — staging is not visible until its
    // descriptor commits, so every possibly-written object must be removed.
    const cleanupFailures: string[] = [];
    for (const key of uploadedKeys.reverse()) {
      try {
        await deleteObject(key);
      } catch (cleanupError) {
        // error-policy:J6 best-effort teardown — aggregate every failed delete
        // and surface the residue instead of hiding it behind the stage error.
        cleanupFailures.push(
          `${key}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    if (cleanupFailures.length > 0) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_STAGE_CLEANUP_FAILED",
        "Backup chunk staging failed and partial objects could not be removed",
        {
          originalError: error instanceof Error ? error.message : String(error),
          cleanupFailures,
        },
      );
    }
    throw error;
  }

  return {
    format: "elizaos.agent-backup-chunks",
    descriptorVersion: 1,
    backupSchemaVersion: 2,
    commitState: "complete",
    organizationId: params.identity.organizationId,
    sandboxRecordId: params.identity.sandboxRecordId,
    backupId: params.identity.backupId,
    objectSetId,
    createdAt: createdAt.toISOString(),
    chunkBytes,
    totalPlaintextBytes,
    totalPlaintextSha256: totalHash.digest("hex"),
    chunks,
  };
}

function validateDescriptor(
  descriptor: AgentBackupChunkDescriptor,
  identity: AgentBackupChunkIdentity,
): void {
  validateIdentity(identity);
  if (
    !descriptor ||
    typeof descriptor !== "object" ||
    descriptor.format !== "elizaos.agent-backup-chunks" ||
    descriptor.descriptorVersion !== 1 ||
    descriptor.backupSchemaVersion !== 2 ||
    descriptor.commitState !== "complete" ||
    descriptor.organizationId !== identity.organizationId ||
    descriptor.sandboxRecordId !== identity.sandboxRecordId ||
    descriptor.backupId !== identity.backupId ||
    typeof descriptor.objectSetId !== "string" ||
    !UUID_RE.test(descriptor.objectSetId) ||
    canonicalCreatedAt(descriptor.createdAt) === null
  ) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
      "Backup chunk descriptor does not match the requested restore identity",
    );
  }
  assertPositiveInteger(descriptor.chunkBytes, "chunkBytes", MAX_CHUNK_BYTES);
  if (
    !Number.isSafeInteger(descriptor.totalPlaintextBytes) ||
    descriptor.totalPlaintextBytes < 0 ||
    descriptor.totalPlaintextBytes > MAX_TOTAL_BYTES ||
    !/^[a-f0-9]{64}$/.test(descriptor.totalPlaintextSha256) ||
    !Array.isArray(descriptor.chunks) ||
    descriptor.chunks.length > MAX_CHUNK_COUNT
  ) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
      "Backup chunk descriptor has invalid aggregate metadata",
    );
  }
  const expectedChunkCount =
    descriptor.totalPlaintextBytes === 0
      ? 0
      : Math.ceil(descriptor.totalPlaintextBytes / descriptor.chunkBytes);
  if (descriptor.chunks.length !== expectedChunkCount) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
      "Backup chunk descriptor does not contain the canonical fixed-size chunk count",
    );
  }
}

function validateChunkMetadata(params: {
  chunk: AgentBackupEncryptedChunk;
  position: number;
  descriptor: AgentBackupChunkDescriptor;
  identity: AgentBackupChunkIdentity;
  createdAt: Date;
  expectedKeyId: string;
}): { nonce: Uint8Array; authTag: Uint8Array } {
  const { chunk, position, descriptor } = params;
  const expectedPlaintextBytes = Math.min(
    descriptor.chunkBytes,
    descriptor.totalPlaintextBytes - position * descriptor.chunkBytes,
  );
  const expectedObjectKey = buildObjectKey({
    ...chunkObjectParams({
      identity: params.identity,
      objectSetId: descriptor.objectSetId,
      createdAt: params.createdAt,
      index: position,
    }),
    extension: "bin",
  });
  if (
    !chunk ||
    typeof chunk !== "object" ||
    chunk.index !== position ||
    chunk.plaintextBytes !== expectedPlaintextBytes ||
    chunk.ciphertextBytes !== expectedPlaintextBytes ||
    !/^[a-f0-9]{64}$/.test(chunk.plaintextSha256) ||
    !/^[a-f0-9]{64}$/.test(chunk.ciphertextSha256) ||
    chunk.objectKey !== expectedObjectKey ||
    chunk.kmsKeyId !== params.expectedKeyId ||
    !Number.isSafeInteger(chunk.kmsKeyVersion) ||
    chunk.kmsKeyVersion < 1
  ) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
      `Backup chunk descriptor is invalid at index ${position}`,
    );
  }
  return {
    nonce: fromBase64(chunk.nonceBase64, `chunks[${position}].nonceBase64`, NONCE_BYTES),
    authTag: fromBase64(chunk.authTagBase64, `chunks[${position}].authTagBase64`, AUTH_TAG_BYTES),
  };
}

export async function* readEncryptedAgentBackupChunks(params: {
  identity: AgentBackupChunkIdentity;
  descriptor: AgentBackupChunkDescriptor;
}): AsyncGenerator<Uint8Array> {
  validateDescriptor(params.descriptor, params.identity);
  const kms = getKmsClient();
  const expectedKeyId = orgKey(params.identity.organizationId, "dek");
  const createdAt = canonicalCreatedAt(params.descriptor.createdAt);
  if (!createdAt) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
      "Backup chunk descriptor has an invalid creation time",
    );
  }
  const validatedChunks = params.descriptor.chunks.map((chunk, position) =>
    validateChunkMetadata({
      chunk,
      position,
      descriptor: params.descriptor,
      identity: params.identity,
      createdAt,
      expectedKeyId,
    }),
  );
  const totalHash = createHash("sha256");
  let totalPlaintextBytes = 0;

  for (const [position, chunk] of params.descriptor.chunks.entries()) {
    const validated = validatedChunks[position];
    if (!validated) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
        `Backup chunk descriptor is invalid at index ${position}`,
      );
    }
    const ciphertext = await getObjectBytes(chunk.objectKey, chunk.ciphertextBytes);
    if (!ciphertext) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_MISSING",
        `Backup chunk ${position} is missing from object storage`,
      );
    }
    if (
      ciphertext.byteLength !== chunk.ciphertextBytes ||
      sha256(ciphertext) !== chunk.ciphertextSha256
    ) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_CIPHERTEXT_INVALID",
        `Backup chunk ${position} failed ciphertext integrity verification`,
      );
    }
    const plaintext = new Uint8Array(
      await kms.decrypt(
        chunk.kmsKeyId,
        ciphertext,
        validated.nonce,
        validated.authTag,
        chunkAad(params.identity, position, chunk.plaintextBytes),
        chunk.kmsKeyVersion,
      ),
    );
    if (
      plaintext.byteLength !== chunk.plaintextBytes ||
      sha256(plaintext) !== chunk.plaintextSha256
    ) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_PLAINTEXT_INVALID",
        `Backup chunk ${position} failed plaintext integrity verification`,
      );
    }
    totalPlaintextBytes += plaintext.byteLength;
    if (totalPlaintextBytes > params.descriptor.totalPlaintextBytes) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_TOTAL_INVALID",
        "Backup chunks exceed the descriptor plaintext size",
      );
    }
    totalHash.update(plaintext);
    yield plaintext;
  }

  if (
    totalPlaintextBytes !== params.descriptor.totalPlaintextBytes ||
    totalHash.digest("hex") !== params.descriptor.totalPlaintextSha256
  ) {
    throw backupChunkError(
      "AGENT_BACKUP_CHUNK_TOTAL_INVALID",
      "Backup chunks do not match the descriptor aggregate integrity",
    );
  }
}
