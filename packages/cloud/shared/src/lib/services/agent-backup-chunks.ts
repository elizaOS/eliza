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
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { orgKey } from "@elizaos/security/kms";
import { getKmsClient } from "../../db/crypto/kms-client";
import { ObjectNamespaces } from "../storage/object-namespace";
import { deleteObject, getObjectBytes, putObjectBytes } from "../storage/object-store";

const textEncoder = new TextEncoder();
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const MAX_CHUNK_COUNT = 512;
const MAX_TOTAL_BYTES = DEFAULT_CHUNK_BYTES * MAX_CHUNK_COUNT;
const CHUNK_CONTENT_TYPE = "application/vnd.elizaos.agent-backup-chunk";

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

function fromBase64(value: string, field: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
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
    let offset = 0;
    while (offset < input.byteLength) {
      const copied = Math.min(chunkBytes - used, input.byteLength - offset);
      target.set(input.subarray(offset, offset + copied), used);
      offset += copied;
      used += copied;
      if (used === chunkBytes) {
        yield target;
        target = new Uint8Array(chunkBytes);
        used = 0;
      }
    }
  }
  if (used > 0) yield target.slice(0, used);
}

function validateIdentity(identity: AgentBackupChunkIdentity): void {
  for (const [name, value] of Object.entries(identity)) {
    if (name === "backupSchemaVersion") continue;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_IDENTITY_INVALID",
        `${name} must be a non-empty string`,
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

export async function stageEncryptedAgentBackupChunks(params: {
  identity: AgentBackupChunkIdentity;
  source: AsyncIterable<Uint8Array>;
  createdAt?: Date;
  chunkBytes?: number;
  maxTotalBytes?: number;
}): Promise<AgentBackupChunkDescriptor> {
  validateIdentity(params.identity);
  const chunkBytes = params.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const maxTotalBytes = params.maxTotalBytes ?? MAX_TOTAL_BYTES;
  assertPositiveInteger(chunkBytes, "chunkBytes", MAX_CHUNK_BYTES);
  assertPositiveInteger(maxTotalBytes, "maxTotalBytes", MAX_TOTAL_BYTES);

  const createdAt = params.createdAt ?? new Date();
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
      const objectKey = await putObjectBytes({
        namespace: ObjectNamespaces.AgentSandboxBackups,
        organizationId: params.identity.organizationId,
        objectId: params.identity.backupId,
        field: `chunk-${String(index).padStart(6, "0")}`,
        createdAt,
        body: ciphertext,
        contentType: CHUNK_CONTENT_TYPE,
      });
      uploadedKeys.push(objectKey);
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
    const cleanupFailures: string[] = [];
    for (const key of uploadedKeys.reverse()) {
      try {
        await deleteObject(key);
      } catch (cleanupError) {
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
    descriptor.format !== "elizaos.agent-backup-chunks" ||
    descriptor.descriptorVersion !== 1 ||
    descriptor.backupSchemaVersion !== 2 ||
    descriptor.commitState !== "complete" ||
    descriptor.organizationId !== identity.organizationId ||
    descriptor.sandboxRecordId !== identity.sandboxRecordId ||
    descriptor.backupId !== identity.backupId
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
}

export async function* readEncryptedAgentBackupChunks(params: {
  identity: AgentBackupChunkIdentity;
  descriptor: AgentBackupChunkDescriptor;
}): AsyncGenerator<Uint8Array> {
  validateDescriptor(params.descriptor, params.identity);
  const kms = getKmsClient();
  const totalHash = createHash("sha256");
  let totalPlaintextBytes = 0;

  for (const [position, chunk] of params.descriptor.chunks.entries()) {
    if (
      chunk.index !== position ||
      !Number.isSafeInteger(chunk.plaintextBytes) ||
      chunk.plaintextBytes < 1 ||
      chunk.plaintextBytes > params.descriptor.chunkBytes ||
      !Number.isSafeInteger(chunk.ciphertextBytes) ||
      chunk.ciphertextBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(chunk.plaintextSha256) ||
      !/^[a-f0-9]{64}$/.test(chunk.ciphertextSha256) ||
      typeof chunk.objectKey !== "string" ||
      !chunk.objectKey.startsWith(`${ObjectNamespaces.AgentSandboxBackups}/`) ||
      typeof chunk.kmsKeyId !== "string" ||
      chunk.kmsKeyId.length === 0 ||
      !Number.isSafeInteger(chunk.kmsKeyVersion) ||
      chunk.kmsKeyVersion < 1
    ) {
      throw backupChunkError(
        "AGENT_BACKUP_CHUNK_DESCRIPTOR_INVALID",
        `Backup chunk descriptor is invalid at index ${position}`,
      );
    }
    const ciphertext = await getObjectBytes(chunk.objectKey);
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
        fromBase64(chunk.nonceBase64, `chunks[${position}].nonceBase64`),
        fromBase64(chunk.authTagBase64, `chunks[${position}].authTagBase64`),
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
