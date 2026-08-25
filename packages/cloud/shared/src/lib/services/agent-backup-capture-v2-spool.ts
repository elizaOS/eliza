/**
 * Durable ciphertext-only filesystem spool for capture-v2/manifest-v3
 * composition. Plaintext is never accepted by this boundary. Legacy v2 spools
 * stay isolated and fail closed; they are never promoted into this namespace.
 */

import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  KMS_AEAD_OPERATION_KEY_BUNDLE_V1,
} from "@elizaos/core/security/kms";
import { AGENT_BACKUP_CHUNK_ENVELOPE_V1, AGENT_BACKUP_MANIFEST_V2_LIMITS } from "@elizaos/shared";
import z from "zod";

const SPOOL_FORMAT = "elizaos.agent-backup.capture-v3-spool" as const;
const SPOOL_VERSION = 3 as const;
const LEGACY_SPOOL_FORMAT = "elizaos.agent-backup.capture-v2-spool" as const;
const LEGACY_SPOOL_VERSION = 2 as const;
const JOURNAL_FILE = "journal.json";
const MANIFEST_FILE = "manifest.json";
const CATALOG_MANIFEST_FILE = "catalog-manifest.json";
const NAMESPACE_DIRECTORY = "agent-backup-capture-v3";
const LEGACY_NAMESPACE_DIRECTORY = "agent-backup-capture-v2";
const LOCK_OWNER_FILE = "owner.json";
const LOCK_FORMAT = "elizaos.agent-backup.capture-v3-spool-lock" as const;
const LOCK_VERSION = 1 as const;
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const MAX_LOCK_OWNER_BYTES = 4096;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_KEY_BUNDLE_CONTEXT_BYTES = 64 * 1024;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OWNER_NONCE_PATTERN = /^[0-9a-f]{48}$/;
const PROCESS_START_TIME_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const LOCK_DIRECTORY_PATTERN =
  /^\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.lock$/;

const SafeIntegerSchema = z.number().int().safe().nonnegative();
const ChunkIndexSchema = SafeIntegerSchema.max(
  AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunksPerComponent - 1,
);
const ChunkSchema = z.strictObject({
  component: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  index: ChunkIndexSchema,
  file: z.string().regex(/^chunk-[a-z][a-z0-9-]{0,63}-[0-9]{6}\.bin$/),
  nonceHex: z.string().regex(/^[0-9a-f]{24}$/),
  plainBytes: SafeIntegerSchema.positive().max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkPlainBytes),
  compressedBytes: SafeIntegerSchema.positive().max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkCompressedBytes,
  ),
  encryptedBytes: SafeIntegerSchema.positive().max(
    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkEncryptedBytes,
  ),
  contentHmacSha256: z.string().regex(SHA256_PATTERN),
  aadSha256: z.string().regex(SHA256_PATTERN),
  ciphertextSha256: z.string().regex(SHA256_PATTERN),
});

const UploadedChunkKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}:(?:0|[1-9][0-9]*)$/);

export type AgentBackupCaptureV3SpoolChunk = z.infer<typeof ChunkSchema>;

const OperationKeyBundleSchema = z.strictObject({
  generationId: z.string().regex(UUID_PATTERN),
  format: z.literal(KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format),
  plaintextBytes: z.literal(KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes),
  nonceBytes: z.literal(KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes),
  authTagBytes: z.literal(KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes),
  bytes: z.literal(KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes),
  sha256: z.string().regex(SHA256_PATTERN),
  localReceiptDerivation: z.literal(KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION),
  localReceiptDigest: z.string().regex(SHA256_PATTERN),
  canonicalContext: z.string().min(1).max(MAX_KEY_BUNDLE_CONTEXT_BYTES),
  canonicalContextSha256: z.string().regex(SHA256_PATTERN),
  ciphertextBase64: z.string().min(4).max(256),
});

const ManifestSchema = z.strictObject({
  file: z.literal(MANIFEST_FILE),
  bytes: z.number().int().safe().positive().max(MAX_MANIFEST_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
});

const CatalogManifestSchema = z.strictObject({
  file: z.literal(CATALOG_MANIFEST_FILE),
  bytes: z.number().int().safe().positive().max(MAX_CATALOG_MANIFEST_BYTES),
  sha256: z.string().regex(SHA256_PATTERN),
});

const LockOwnerSchema = z.strictObject({
  format: z.literal(LOCK_FORMAT),
  version: z.literal(LOCK_VERSION),
  operationId: z.string().regex(UUID_PATTERN),
  executionToken: z.string().regex(UUID_PATTERN),
  linuxBootId: z.string().regex(UUID_PATTERN),
  pid: z.number().int().safe().positive(),
  processStartTime: z.string().regex(PROCESS_START_TIME_PATTERN),
  ownerNonce: z.string().regex(OWNER_NONCE_PATTERN),
});

const JournalSchema = z
  .strictObject({
    format: z.literal(SPOOL_FORMAT),
    version: z.literal(SPOOL_VERSION),
    operationId: z.string().regex(UUID_PATTERN),
    requestSha256: z.string().regex(SHA256_PATTERN),
    authoritySha256: z.string().regex(SHA256_PATTERN),
    runtimePrincipalSha256: z.string().regex(SHA256_PATTERN),
    phase: z.enum(["initialized", "capturing", "sealed", "publishing", "published"]),
    operationKeyBundle: OperationKeyBundleSchema.optional(),
    chunks: z.array(ChunkSchema).max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks),
    manifest: ManifestSchema.optional(),
    catalogManifest: CatalogManifestSchema.optional(),
    recordCaptured: z.enum(["pending", "confirmed"]),
    uploadedChunkKeys: z
      .array(UploadedChunkKeySchema)
      .max(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks),
    cleanup: z.literal("pending"),
    committedBytes: SafeIntegerSchema,
  })
  .superRefine((value, context) => {
    const chunkKeys = new Set<string>();
    const componentNames = new Set<string>();
    const nonces = new Set<string>();
    let previousChunk: AgentBackupCaptureV3SpoolChunk | undefined;
    for (let index = 0; index < value.chunks.length; index += 1) {
      const chunk = value.chunks[index];
      if (!chunk) continue;
      const key = `${chunk.component}:${chunk.index}`;
      componentNames.add(chunk.component);
      if (chunk.file !== chunkFile(chunk.component, chunk.index)) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index, "file"],
          message: "Ciphertext artifact name differs from its chunk identity",
        });
      }
      if (chunkKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index],
          message: "Ciphertext chunk identities must be unique",
        });
      }
      chunkKeys.add(key);
      if (nonces.has(chunk.nonceHex)) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index, "nonceHex"],
          message: "Ciphertext nonces must be unique within one operation",
        });
      }
      nonces.add(chunk.nonceHex);
      if (
        chunk.compressedBytes !== chunk.plainBytes ||
        chunk.encryptedBytes !==
          chunk.compressedBytes +
            AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes +
            AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes
      ) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index, "encryptedBytes"],
          message: "Capture-v3 spool chunks require the canonical uncompressed GCM envelope",
        });
      }
      if (previousChunk) {
        const componentOrder = compareCanonicalComponentNames(
          previousChunk.component,
          chunk.component,
        );
        if (
          componentOrder > 0 ||
          (componentOrder === 0 && chunk.index !== previousChunk.index + 1)
        ) {
          context.addIssue({
            code: "custom",
            path: ["chunks", index],
            message: "Ciphertext chunks must use canonical component and contiguous index order",
          });
        }
      } else if (chunk.index !== 0) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index, "index"],
          message: "The first ciphertext chunk for a component must have index zero",
        });
      }
      if (previousChunk?.component !== chunk.component && chunk.index !== 0) {
        context.addIssue({
          code: "custom",
          path: ["chunks", index, "index"],
          message: "The first ciphertext chunk for a component must have index zero",
        });
      }
      previousChunk = chunk;
    }
    if (componentNames.size > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxComponents) {
      context.addIssue({
        code: "custom",
        path: ["chunks"],
        message: "Ciphertext inventory exceeds the component limit",
      });
    }

    const uploadedKeys = new Set(value.uploadedChunkKeys);
    if (uploadedKeys.size !== value.uploadedChunkKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["uploadedChunkKeys"],
        message: "Ciphertext upload receipts must be unique",
      });
    }
    for (let index = 0; index < value.uploadedChunkKeys.length; index += 1) {
      const key = value.uploadedChunkKeys[index];
      if (key && !chunkKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["uploadedChunkKeys", index],
          message: "Ciphertext upload receipt references an unknown chunk",
        });
      }
      if (
        index > 0 &&
        key !== undefined &&
        value.uploadedChunkKeys[index - 1] !== undefined &&
        compareCanonicalComponentNames(value.uploadedChunkKeys[index - 1] ?? "", key) >= 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["uploadedChunkKeys", index],
          message: "Ciphertext upload receipts must use canonical order",
        });
      }
    }
    if (value.recordCaptured === "confirmed" && !value.catalogManifest) {
      context.addIssue({
        code: "custom",
        path: ["catalogManifest"],
        message: "Confirmed catalogue handoff requires exact durable bytes",
      });
    }
    if (value.catalogManifest && value.recordCaptured !== "confirmed") {
      context.addIssue({
        code: "custom",
        path: ["recordCaptured"],
        message: "Durable catalogue bytes require a confirmed handoff receipt",
      });
    }
    if (value.manifest && !value.operationKeyBundle) {
      context.addIssue({
        code: "custom",
        path: ["operationKeyBundle"],
        message: "A sealed v3 manifest requires one operation key bundle",
      });
    }
    if (
      (value.phase === "sealed" || value.phase === "publishing" || value.phase === "published") &&
      !value.manifest
    ) {
      context.addIssue({
        code: "custom",
        path: ["manifest"],
        message: "A sealed or publishing operation requires a durable manifest",
      });
    }
    if (
      (value.phase === "initialized" || value.phase === "capturing") &&
      (value.manifest ||
        value.catalogManifest ||
        value.recordCaptured === "confirmed" ||
        value.uploadedChunkKeys.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "An unsealed operation cannot contain publication authority",
      });
    }
    if (value.phase === "initialized" && (value.operationKeyBundle || value.chunks.length > 0)) {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "An initialized operation cannot contain capture artifacts",
      });
    }
    if (value.phase === "capturing" && !value.operationKeyBundle) {
      context.addIssue({
        code: "custom",
        path: ["operationKeyBundle"],
        message: "A capturing v3 operation requires its durable key bundle",
      });
    }
    if (
      value.phase !== "publishing" &&
      value.phase !== "published" &&
      value.uploadedChunkKeys.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["uploadedChunkKeys"],
        message: "Chunk upload receipts require an active publication phase",
      });
    }
    if (
      value.phase === "published" &&
      (value.recordCaptured !== "confirmed" || uploadedKeys.size !== chunkKeys.size)
    ) {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "Published state requires catalogue and every chunk receipt",
      });
    }
  });

const LegacyJournalHeaderSchema = z.object({
  format: z.literal(LEGACY_SPOOL_FORMAT),
  version: z.literal(LEGACY_SPOOL_VERSION),
  operationId: z.string().regex(UUID_PATTERN),
});

type SpoolJournal = z.infer<typeof JournalSchema>;
type SpoolLockOwner = z.infer<typeof LockOwnerSchema>;

export interface AgentBackupCaptureV3SpoolProcessIdentity {
  linuxBootId: string;
  pid: number;
  /** Linux `/proc/<pid>/stat` field 22, expressed in clock ticks. */
  processStartTime: string;
}

export interface AgentBackupCaptureV3SpoolLockAuthority {
  /** Trusted local-host identity for the process acquiring this operation. */
  currentProcessIdentity(): Promise<AgentBackupCaptureV3SpoolProcessIdentity>;
  /** Must return false only when the exact boot/pid/starttime identity is dead. */
  isProcessIdentityAlive(identity: AgentBackupCaptureV3SpoolProcessIdentity): Promise<boolean>;
}

export interface AgentBackupCaptureV3SpoolConfig {
  /** Explicit persistent StateDirectory; no temporary-directory fallback. */
  stateDirectory: string;
  maxSpoolBytes: number;
  /** Space that must remain available after the next durable write. */
  minFreeBytes: number;
  /** Host authority is injectable only for deterministic non-Linux tests. */
  lockAuthority?: AgentBackupCaptureV3SpoolLockAuthority;
}

export interface OpenAgentBackupCaptureV3SpoolInput {
  operationId: string;
  /** Durable job execution fence; distinct claimants must use distinct UUIDs. */
  executionToken: string;
  requestSha256: string;
  authoritySha256: string;
  /**
   * Canonical wire-principal digest. Required for capture/replay; publication
   * may omit it only after the spool is sealed and can no longer append bytes.
   */
  runtimePrincipalSha256?: string;
}

export interface AgentBackupCaptureV3OperationKeyBundleMetadata {
  generationId: string;
  format: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format;
  plaintextBytes: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes;
  nonceBytes: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes;
  authTagBytes: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes;
  bytes: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes;
  sha256: string;
  localReceiptDerivation: typeof KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION;
  localReceiptDigest: string;
  canonicalContext: string;
  canonicalContextSha256: string;
}

export interface AgentBackupCaptureV3ManifestMetadata {
  bytes: number;
  sha256: string;
}

export interface AgentBackupCaptureV3CatalogManifestMetadata {
  bytes: number;
  sha256: string;
}

export interface AgentBackupCaptureV3CleanupReceipt {
  operationId: string;
  status: "complete" | "pending";
}

export interface AgentBackupCaptureV3DurableOperationAuthority {
  operationId: string;
  requestSha256: string;
  authoritySha256: string;
  runtimePrincipalSha256: string;
  phase: SpoolJournal["phase"];
  recordCaptured: boolean;
}

export class AgentBackupCaptureV3SpoolError extends Error {
  override readonly name = "AgentBackupCaptureV3SpoolError";

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function spoolError(code: string, message: string, cause?: unknown): never {
  throw new AgentBackupCaptureV3SpoolError(code, message, { cause });
}

function assertSafeByteCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    spoolError("AGENT_BACKUP_V2_SPOOL_CONFIG_INVALID", `${name} must be a safe byte count`);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function lstatRegularFile(filePath: string): Promise<fs.Stats | null> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_UNSAFE_ENTRY",
        "Backup spool artifact is not a regular file",
      );
    }
    return stat;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

async function hashFile(
  filePath: string,
  maxBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const hash = createHash("sha256");
  const buffer = new Uint8Array(256 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const read = await handle.read(buffer, 0, buffer.byteLength, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > maxBytes) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_ARTIFACT_TOO_LARGE",
          "Backup spool artifact exceeds its declared bound",
        );
      }
      hash.update(buffer.subarray(0, read.bytesRead));
    }
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function readBoundedFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const stat = await lstatRegularFile(filePath);
  if (!stat || stat.size > maxBytes) {
    spoolError(
      "AGENT_BACKUP_V2_SPOOL_ARTIFACT_INVALID",
      "Backup spool artifact is missing or exceeds its bound",
    );
  }
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  const bytes = new Uint8Array(stat.size);
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_TRUNCATED",
          "Backup spool artifact was truncated while reading",
        );
      }
      offset += read.bytesRead;
    }
  } finally {
    await handle.close();
  }
  return bytes;
}

function parseLinuxProcessStartTime(stat: string): string {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 2 || stat[commandEnd + 1] !== " ") {
    spoolError(
      "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
      "Linux process stat record is malformed",
    );
  }
  // Tokens after the command begin with field 3 (`state`); starttime is field 22.
  const fields = stat
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  if (!startTime || !PROCESS_START_TIME_PATTERN.test(startTime)) {
    spoolError(
      "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
      "Linux process starttime is unavailable",
    );
  }
  return startTime;
}

async function readLinuxProcessStartTime(pid: number): Promise<string | null> {
  try {
    const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf8");
    if (stat.length > MAX_LOCK_OWNER_BYTES) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
        "Linux process stat record exceeds its bound",
      );
    }
    return parseLinuxProcessStartTime(stat);
  } catch (cause) {
    // error-policy:J2 ENOENT proves the exact PID is absent; every other host
    // inspection failure is retained because lock takeover must fail closed.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

const linuxSpoolLockAuthority: AgentBackupCaptureV3SpoolLockAuthority = {
  async currentProcessIdentity() {
    if (process.platform !== "linux") {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
        "Capture spool locking requires Linux /proc process identity",
      );
    }
    const linuxBootId = (
      await fs.promises.readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim();
    const processStartTime = await readLinuxProcessStartTime(process.pid);
    if (!UUID_PATTERN.test(linuxBootId) || processStartTime === null) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
        "Current Linux boot or process identity is unavailable",
      );
    }
    return { linuxBootId, pid: process.pid, processStartTime };
  },
  async isProcessIdentityAlive(identity) {
    if (process.platform !== "linux") {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
        "Capture spool lock liveness requires Linux /proc",
      );
    }
    const currentBootId = (
      await fs.promises.readFile("/proc/sys/kernel/random/boot_id", "utf8")
    ).trim();
    if (!UUID_PATTERN.test(currentBootId)) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
        "Current Linux boot identity is invalid",
      );
    }
    if (currentBootId !== identity.linuxBootId) return false;
    const observedStartTime = await readLinuxProcessStartTime(identity.pid);
    return observedStartTime !== null && observedStartTime === identity.processStartTime;
  },
};

interface AcquiredSpoolLock {
  authority: AgentBackupCaptureV3SpoolLockAuthority;
  directory: string;
  ownerPath: string;
  ownerHandle: fs.promises.FileHandle;
  ownerStat: fs.Stats;
  record: SpoolLockOwner;
}

async function readLockOwner(ownerPath: string): Promise<SpoolLockOwner> {
  try {
    const bytes = await readBoundedFile(ownerPath, MAX_LOCK_OWNER_BYTES);
    return LockOwnerSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (cause) {
    // error-policy:J1 an invalid owner destroys the only safe liveness proof;
    // retain the parse failure and refuse takeover.
    spoolError(
      "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
      "Capture spool lock owner is invalid",
      cause,
    );
  }
}

async function removeReclaimableLockDirectory(directory: string): Promise<void> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name !== LOCK_OWNER_FILE || !entry.isFile() || entry.isSymbolicLink()) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
        "Reclaimable capture spool lock contains an unsafe entry",
      );
    }
    await fs.promises.unlink(path.join(directory, entry.name));
  }
  await fs.promises.rmdir(directory);
}

async function acquireSpoolLock(input: {
  namespaceDirectory: string;
  operationId: string;
  executionToken: string;
  authority: AgentBackupCaptureV3SpoolLockAuthority;
}): Promise<AcquiredSpoolLock> {
  const identity = await input.authority.currentProcessIdentity();
  const record = LockOwnerSchema.parse({
    format: LOCK_FORMAT,
    version: LOCK_VERSION,
    operationId: input.operationId,
    executionToken: input.executionToken,
    ...identity,
    ownerNonce: bytesToHex(randomBytes(24)),
  });
  const directory = path.join(input.namespaceDirectory, `.${input.operationId}.lock`);
  const ownerPath = path.join(directory, LOCK_OWNER_FILE);

  for (;;) {
    try {
      await fs.promises.mkdir(directory, { mode: DIRECTORY_MODE });
    } catch (cause) {
      // error-policy:J2 EEXIST is inspected through exact Linux process
      // identity. No age, timeout, or execution token can prove an owner dead.
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const existing = await readLockOwner(ownerPath);
      let alive: boolean;
      try {
        alive = await input.authority.isProcessIdentityAlive({
          linuxBootId: existing.linuxBootId,
          pid: existing.pid,
          processStartTime: existing.processStartTime,
        });
      } catch (livenessCause) {
        // error-policy:J2 an inspection failure cannot prove the prior owner
        // dead, so takeover fails closed with a stable domain error.
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_LOCK_LIVENESS_UNPROVABLE",
          "Capture spool lock owner liveness could not be proven",
          livenessCause,
        );
      }
      if (alive) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_LOCKED",
          "Backup operation spool is owned by a live process",
        );
      }
      const quarantine = `${directory}.reclaim-${record.ownerNonce}`;
      try {
        await fs.promises.rename(directory, quarantine);
      } catch (renameCause) {
        // error-policy:J2 another claimant may have completed the exact
        // reclaim first; retry only when the source disappeared.
        if ((renameCause as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameCause;
      }
      await removeReclaimableLockDirectory(quarantine);
      await fsyncDirectory(input.namespaceDirectory);
      continue;
    }

    let ownerHandle: fs.promises.FileHandle | undefined;
    try {
      ownerHandle = await fs.promises.open(
        ownerPath,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_RDWR |
          (fs.constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      );
      const bytes = new TextEncoder().encode(JSON.stringify(record));
      await ownerHandle.writeFile(bytes);
      await ownerHandle.sync();
      await fsyncDirectory(directory);
      await fsyncDirectory(input.namespaceDirectory);
      const ownerStat = await ownerHandle.stat();
      return {
        authority: input.authority,
        directory,
        ownerPath,
        ownerHandle,
        ownerStat,
        record,
      };
    } catch (cause) {
      // error-policy:J3 retain initialization failure after best-effort
      // removal of this claimant's incomplete lock directory.
      await ownerHandle?.close().catch(() => undefined);
      await fs.promises.unlink(ownerPath).catch(() => undefined);
      await fs.promises.rmdir(directory).catch(() => undefined);
      throw cause;
    }
  }
}

async function assertSpoolLockOwner(lock: AcquiredSpoolLock): Promise<void> {
  let current: fs.Stats;
  try {
    current = await fs.promises.lstat(lock.ownerPath);
  } catch (cause) {
    // error-policy:J1 loss of the exact owner inode is a hard execution-fence
    // failure; retain the filesystem cause for the caller.
    spoolError(
      "AGENT_BACKUP_V2_SPOOL_LOCK_LOST",
      "Backup spool execution lock is no longer current",
      cause,
    );
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== lock.ownerStat.dev ||
    current.ino !== lock.ownerStat.ino
  ) {
    spoolError(
      "AGENT_BACKUP_V2_SPOOL_LOCK_LOST",
      "Backup spool execution lock was replaced by another claimant",
    );
  }
  const currentRecord = await readLockOwner(lock.ownerPath);
  if (
    currentRecord.ownerNonce !== lock.record.ownerNonce ||
    currentRecord.executionToken !== lock.record.executionToken ||
    currentRecord.operationId !== lock.record.operationId
  ) {
    spoolError(
      "AGENT_BACKUP_V2_SPOOL_LOCK_LOST",
      "Backup spool owner nonce or execution token changed",
    );
  }
}

async function releaseSpoolLock(lock: AcquiredSpoolLock): Promise<void> {
  let stillOwner = false;
  try {
    await assertSpoolLockOwner(lock);
    stillOwner = true;
  } catch {
    // error-policy:J4 a superseded claimant must never unlink the successor's
    // lock; closing its private inode is the only safe action.
  }
  await lock.ownerHandle.close();
  if (!stillOwner) return;
  await fs.promises.unlink(lock.ownerPath);
  await fsyncDirectory(lock.directory);
  await fs.promises.rmdir(lock.directory);
  await fsyncDirectory(path.dirname(lock.directory));
}

function isOwnedTemporaryArtifact(name: string): boolean {
  return /^\.(?:journal\.json|manifest\.json|catalog-manifest\.json|chunk-[a-z][a-z0-9-]{0,63}-[0-9]{6}\.bin)\.[0-9a-f]{24}\.tmp$/.test(
    name,
  );
}

function compareCanonicalComponentNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function chunkKey(chunk: Pick<AgentBackupCaptureV3SpoolChunk, "component" | "index">): string {
  return `${chunk.component}:${chunk.index}`;
}

function chunkFile(component: string, index: number): string {
  return `chunk-${component}-${String(index).padStart(6, "0")}.bin`;
}

function equalChunk(
  left: AgentBackupCaptureV3SpoolChunk,
  right: AgentBackupCaptureV3SpoolChunk,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function assertNoLegacyV2Spool(stateDirectory: string, operationId: string): Promise<void> {
  const legacyNamespace = path.join(stateDirectory, LEGACY_NAMESPACE_DIRECTORY);
  let namespaceStat: fs.Stats;
  try {
    namespaceStat = await fs.promises.lstat(legacyNamespace);
  } catch (cause) {
    // error-policy:J2 absence proves there is no legacy operation to quarantine.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  if (namespaceStat.isSymbolicLink() || !namespaceStat.isDirectory()) {
    spoolError(
      "AGENT_BACKUP_V3_LEGACY_SPOOL_UNSAFE",
      "Legacy backup spool namespace is not a safe directory",
    );
  }
  const legacyLockDirectory = path.join(legacyNamespace, `.${operationId}.lock`);
  try {
    await fs.promises.lstat(legacyLockDirectory);
    spoolError(
      "AGENT_BACKUP_V3_LEGACY_SPOOL_QUARANTINED",
      "Legacy backup operation lock is isolated and cannot be promoted to v3",
    );
  } catch (cause) {
    // error-policy:J2 absence proves no legacy claimant currently owns the
    // well-known v2 lock path; every observed entry is quarantined above.
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const legacyOperationDirectory = path.join(legacyNamespace, operationId);
  let operationStat: fs.Stats;
  try {
    operationStat = await fs.promises.lstat(legacyOperationDirectory);
  } catch (cause) {
    // error-policy:J2 absence proves this operation has no legacy spool.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    throw cause;
  }
  if (operationStat.isSymbolicLink() || !operationStat.isDirectory()) {
    spoolError(
      "AGENT_BACKUP_V3_LEGACY_SPOOL_UNSAFE",
      "Legacy backup operation spool is not a safe directory",
    );
  }
  try {
    const journal = await readBoundedFile(
      path.join(legacyOperationDirectory, JOURNAL_FILE),
      MAX_JOURNAL_BYTES,
    );
    const header = LegacyJournalHeaderSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(journal)),
    );
    if (header.operationId !== operationId) {
      spoolError(
        "AGENT_BACKUP_V3_LEGACY_SPOOL_UNSAFE",
        "Legacy backup spool identity differs from its directory",
      );
    }
  } catch (cause) {
    // error-policy:J1 an unreadable legacy spool cannot be reinterpreted as v3.
    if (cause instanceof AgentBackupCaptureV3SpoolError) throw cause;
    spoolError(
      "AGENT_BACKUP_V3_LEGACY_SPOOL_UNSAFE",
      "Legacy backup spool cannot be safely classified",
      cause,
    );
  }
  spoolError(
    "AGENT_BACKUP_V3_LEGACY_SPOOL_QUARANTINED",
    "Legacy manifest-v2 spool is isolated and cannot be promoted to v3",
  );
}

/** Ciphertext-only, one-operation durable spool. */
export class AgentBackupCaptureV3Spool {
  private closed = false;
  private cleanupComplete = false;

  private constructor(
    private readonly config: Readonly<AgentBackupCaptureV3SpoolConfig>,
    readonly namespaceDirectory: string,
    readonly operationDirectory: string,
    private journal: SpoolJournal,
    private readonly lock: AcquiredSpoolLock,
  ) {}

  static async open(
    configInput: Readonly<AgentBackupCaptureV3SpoolConfig>,
    input: Readonly<OpenAgentBackupCaptureV3SpoolInput>,
  ): Promise<AgentBackupCaptureV3Spool> {
    const spool = await AgentBackupCaptureV3Spool.openInternal(configInput, input, false);
    if (!spool) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_OPEN_INVALID",
        "Fresh backup spool open unexpectedly resolved as absent",
      );
    }
    return spool;
  }

  /** Open only durable existing artifacts; never recreate a cleaned operation. */
  static async openExisting(
    configInput: Readonly<AgentBackupCaptureV3SpoolConfig>,
    input: Readonly<OpenAgentBackupCaptureV3SpoolInput>,
  ): Promise<AgentBackupCaptureV3Spool | undefined> {
    return AgentBackupCaptureV3Spool.openInternal(configInput, input, true);
  }

  /**
   * Enumerate only validated journal authorities. This is the protected-cleanup
   * recovery cursor after a catalogue transition response is lost.
   */
  static async listDurableOperationAuthorities(
    configInput: Readonly<AgentBackupCaptureV3SpoolConfig>,
  ): Promise<AgentBackupCaptureV3DurableOperationAuthority[]> {
    const config = { ...configInput };
    assertSafeByteCount(config.maxSpoolBytes, "maxSpoolBytes");
    assertSafeByteCount(config.minFreeBytes, "minFreeBytes");
    if (config.maxSpoolBytes === 0 || !path.isAbsolute(config.stateDirectory)) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_CONFIG_INVALID",
        "Backup spool discovery requires an absolute persistent directory and positive cap",
      );
    }
    const stateDirectory = path.resolve(config.stateDirectory);
    let stateStat: fs.Stats;
    try {
      stateStat = await fs.promises.lstat(stateDirectory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    const realStateDirectory = await fs.promises.realpath(stateDirectory);
    if (
      stateStat.isSymbolicLink() ||
      !stateStat.isDirectory() ||
      realStateDirectory !== stateDirectory
    ) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_STATE_DIRECTORY_UNSAFE",
        "Backup StateDirectory must not traverse a symbolic link",
      );
    }
    const realTemporaryDirectory = await fs.promises.realpath(os.tmpdir());
    const relativeToTemporary = path.relative(realTemporaryDirectory, stateDirectory);
    if (
      relativeToTemporary === "" ||
      (!relativeToTemporary.startsWith("..") && !path.isAbsolute(relativeToTemporary))
    ) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_STATE_DIRECTORY_TEMPORARY",
        "Backup StateDirectory must be persistent and outside the system temporary directory",
      );
    }
    const namespaceDirectory = path.join(stateDirectory, NAMESPACE_DIRECTORY);
    let namespaceStat: fs.Stats;
    try {
      namespaceStat = await fs.promises.lstat(namespaceDirectory);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw cause;
    }
    if (namespaceStat.isSymbolicLink() || !namespaceStat.isDirectory()) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_STATE_DIRECTORY_UNSAFE",
        "Backup spool namespace is not a safe directory",
      );
    }
    const authorities: AgentBackupCaptureV3DurableOperationAuthority[] = [];
    const entries = await fs.promises.readdir(namespaceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (LOCK_DIRECTORY_PATTERN.test(entry.name)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          spoolError(
            "AGENT_BACKUP_V2_SPOOL_UNSAFE_ENTRY",
            "Backup spool discovery encountered an unsafe lock entry",
          );
        }
        continue;
      }
      if (!UUID_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_UNSAFE_ENTRY",
          "Backup spool discovery encountered an unsafe namespace entry",
        );
      }
      let raw: Uint8Array;
      try {
        raw = await readBoundedFile(
          path.join(namespaceDirectory, entry.name, JOURNAL_FILE),
          MAX_JOURNAL_BYTES,
        );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw cause;
      }
      let journal: SpoolJournal;
      try {
        journal = JournalSchema.parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
        );
      } catch (cause) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_JOURNAL_INVALID",
          "Backup spool discovery found an invalid journal",
          cause,
        );
      }
      if (journal.operationId !== entry.name) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
          "Backup spool journal differs from its operation directory",
        );
      }
      authorities.push(
        Object.freeze({
          operationId: journal.operationId,
          requestSha256: journal.requestSha256,
          authoritySha256: journal.authoritySha256,
          runtimePrincipalSha256: journal.runtimePrincipalSha256,
          phase: journal.phase,
          recordCaptured: journal.recordCaptured === "confirmed",
        }),
      );
    }
    authorities.sort((left, right) => left.operationId.localeCompare(right.operationId));
    return authorities;
  }

  private static async openInternal(
    configInput: Readonly<AgentBackupCaptureV3SpoolConfig>,
    input: Readonly<OpenAgentBackupCaptureV3SpoolInput>,
    requireExisting: boolean,
  ): Promise<AgentBackupCaptureV3Spool | undefined> {
    const config = { ...configInput };
    assertSafeByteCount(config.maxSpoolBytes, "maxSpoolBytes");
    assertSafeByteCount(config.minFreeBytes, "minFreeBytes");
    if (config.maxSpoolBytes === 0) {
      spoolError("AGENT_BACKUP_V2_SPOOL_CONFIG_INVALID", "maxSpoolBytes must be positive");
    }
    if (!path.isAbsolute(config.stateDirectory)) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_STATE_DIRECTORY_INVALID",
        "Backup StateDirectory must be an absolute persistent path",
      );
    }
    if (!UUID_PATTERN.test(input.operationId)) {
      spoolError("AGENT_BACKUP_V2_SPOOL_IDENTITY_INVALID", "operationId must be canonical UUID");
    }
    if (!UUID_PATTERN.test(input.executionToken)) {
      spoolError("AGENT_BACKUP_V2_SPOOL_IDENTITY_INVALID", "executionToken must be canonical UUID");
    }
    if (
      !SHA256_PATTERN.test(input.requestSha256) ||
      !SHA256_PATTERN.test(input.authoritySha256) ||
      (input.runtimePrincipalSha256 !== undefined &&
        !SHA256_PATTERN.test(input.runtimePrincipalSha256))
    ) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_IDENTITY_INVALID",
        "Spool request, authority, and runtime-principal digests must be SHA-256 hex",
      );
    }

    const stateDirectory = path.resolve(config.stateDirectory);
    await fs.promises.mkdir(stateDirectory, { recursive: true, mode: DIRECTORY_MODE });
    const stateStat = await fs.promises.lstat(stateDirectory);
    const realStateDirectory = await fs.promises.realpath(stateDirectory);
    if (
      stateStat.isSymbolicLink() ||
      !stateStat.isDirectory() ||
      realStateDirectory !== stateDirectory
    ) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_STATE_DIRECTORY_UNSAFE",
        "Backup StateDirectory must not traverse a symbolic link",
      );
    }
    const realTemporaryDirectory = await fs.promises.realpath(os.tmpdir());
    const relativeToTemporary = path.relative(realTemporaryDirectory, stateDirectory);
    if (
      relativeToTemporary === "" ||
      (!relativeToTemporary.startsWith("..") && !path.isAbsolute(relativeToTemporary))
    ) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_STATE_DIRECTORY_TEMPORARY",
        "Backup StateDirectory must be persistent and outside the system temporary directory",
      );
    }
    await assertNoLegacyV2Spool(stateDirectory, input.operationId);
    const namespaceDirectory = path.join(stateDirectory, NAMESPACE_DIRECTORY);
    await fs.promises.mkdir(namespaceDirectory, {
      recursive: true,
      mode: DIRECTORY_MODE,
    });
    const namespaceStat = await fs.promises.lstat(namespaceDirectory);
    if (namespaceStat.isSymbolicLink() || !namespaceStat.isDirectory()) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_STATE_DIRECTORY_UNSAFE",
        "Backup spool namespace is not a safe directory",
      );
    }
    const lock = await acquireSpoolLock({
      namespaceDirectory,
      operationId: input.operationId,
      executionToken: input.executionToken,
      authority: config.lockAuthority ?? linuxSpoolLockAuthority,
    });
    try {
      // Narrow the cross-namespace cutover race after v3 ownership. Deployment
      // must still drain v2 writers because old binaries do not know this lock.
      await assertNoLegacyV2Spool(stateDirectory, input.operationId);
      const operationDirectory = path.join(namespaceDirectory, input.operationId);
      let operationStat: fs.Stats;
      try {
        operationStat = await fs.promises.lstat(operationDirectory);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        if (requireExisting) {
          await releaseSpoolLock(lock);
          return undefined;
        }
        await fs.promises.mkdir(operationDirectory, {
          recursive: false,
          mode: DIRECTORY_MODE,
        });
        operationStat = await fs.promises.lstat(operationDirectory);
      }
      if (operationStat.isSymbolicLink() || !operationStat.isDirectory()) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_STATE_DIRECTORY_UNSAFE",
          "Backup operation spool is not a safe directory",
        );
      }

      const journalPath = path.join(operationDirectory, JOURNAL_FILE);
      const existing = await lstatRegularFile(journalPath);
      if (requireExisting && !existing) {
        await releaseSpoolLock(lock);
        return undefined;
      }
      let journal: SpoolJournal;
      if (existing) {
        const raw = await readBoundedFile(journalPath, MAX_JOURNAL_BYTES);
        try {
          journal = JournalSchema.parse(JSON.parse(new TextDecoder().decode(raw)));
        } catch (cause) {
          // error-policy:J1 invalid durable authority is retained and blocks
          // replay; it is never replaced by a fresh journal.
          spoolError(
            "AGENT_BACKUP_V2_SPOOL_JOURNAL_INVALID",
            "Backup spool journal is invalid",
            cause,
          );
        }
        if (
          journal.operationId !== input.operationId ||
          journal.requestSha256 !== input.requestSha256 ||
          journal.authoritySha256 !== input.authoritySha256
        ) {
          spoolError(
            "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
            "Backup operation spool belongs to different immutable authority",
          );
        }
        if (
          input.runtimePrincipalSha256 !== undefined &&
          journal.runtimePrincipalSha256 !== input.runtimePrincipalSha256
        ) {
          spoolError(
            "AGENT_BACKUP_V3_RUNTIME_PRINCIPAL_REPLAY_CONFLICT",
            "Backup operation spool belongs to a different runtime wire principal",
          );
        }
        if (
          input.runtimePrincipalSha256 === undefined &&
          (journal.phase === "initialized" || journal.phase === "capturing")
        ) {
          spoolError(
            "AGENT_BACKUP_V3_RUNTIME_PRINCIPAL_REQUIRED",
            "Append-capable backup spool replay requires its exact runtime wire principal",
          );
        }
      } else {
        if (input.runtimePrincipalSha256 === undefined) {
          spoolError(
            "AGENT_BACKUP_V3_RUNTIME_PRINCIPAL_REQUIRED",
            "Fresh backup spool capture requires an exact runtime wire principal",
          );
        }
        journal = {
          format: SPOOL_FORMAT,
          version: SPOOL_VERSION,
          operationId: input.operationId,
          requestSha256: input.requestSha256,
          authoritySha256: input.authoritySha256,
          runtimePrincipalSha256: input.runtimePrincipalSha256,
          phase: "initialized",
          chunks: [],
          recordCaptured: "pending",
          uploadedChunkKeys: [],
          cleanup: "pending",
          committedBytes: 0,
        };
      }
      const spool = new AgentBackupCaptureV3Spool(
        Object.freeze({ ...config, stateDirectory }),
        namespaceDirectory,
        operationDirectory,
        journal,
        lock,
      );
      await spool.reapTemporaryArtifacts();
      if (!existing) await spool.persistJournal();
      await spool.verifyCommittedAccounting();
      await spool.preflightWrite(0);
      return spool;
    } catch (cause) {
      // error-policy:J3 opening never leaks ownership. Preserve both the open
      // failure and a lock-release failure when the filesystem reports both.
      try {
        await releaseSpoolLock(lock);
      } catch (releaseCause) {
        throw new AggregateError(
          [cause, releaseCause],
          "Backup spool open and lock release both failed",
        );
      }
      throw cause;
    }
  }

  get operationId(): string {
    return this.journal.operationId;
  }

  get phase(): SpoolJournal["phase"] {
    return this.journal.phase;
  }

  get chunks(): readonly AgentBackupCaptureV3SpoolChunk[] {
    return this.journal.chunks.map((chunk) => Object.freeze({ ...chunk }));
  }

  get recordCaptured(): boolean {
    return this.journal.recordCaptured === "confirmed";
  }

  isChunkUploaded(chunk: Pick<AgentBackupCaptureV3SpoolChunk, "component" | "index">): boolean {
    return this.journal.uploadedChunkKeys.includes(chunkKey(chunk));
  }

  private assertOpen(): void {
    if (this.closed) {
      spoolError("AGENT_BACKUP_V2_SPOOL_CLOSED", "Backup operation spool is closed");
    }
  }

  private async assertMutationAuthority(): Promise<void> {
    this.assertOpen();
    await assertSpoolLockOwner(this.lock);
  }

  private async reapTemporaryArtifacts(): Promise<void> {
    await this.assertMutationAuthority();
    const entries = await fs.promises.readdir(this.operationDirectory, {
      withFileTypes: true,
    });
    let reaped = false;
    for (const entry of entries) {
      if (!isOwnedTemporaryArtifact(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_UNSAFE_ENTRY",
          "Backup spool temporary artifact is not a regular file",
        );
      }
      await this.assertMutationAuthority();
      await fs.promises.unlink(path.join(this.operationDirectory, entry.name));
      reaped = true;
    }
    if (reaped) await fsyncDirectory(this.operationDirectory);
  }

  private async preflightWrite(bytes: number): Promise<void> {
    await this.assertMutationAuthority();
    assertSafeByteCount(bytes, "artifact bytes");
    let physicalBytes = 0;
    const entries = await fs.promises.readdir(this.operationDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_UNSAFE_ENTRY",
          "Backup spool contains a non-regular filesystem entry",
        );
      }
      const stat = await fs.promises.lstat(path.join(this.operationDirectory, entry.name));
      physicalBytes += stat.size;
      if (!Number.isSafeInteger(physicalBytes)) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_ACCOUNTING_INVALID",
          "Backup spool physical byte accounting overflowed",
        );
      }
    }
    if (physicalBytes > this.config.maxSpoolBytes - bytes) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_QUOTA_EXCEEDED",
        "Backup operation physical files would exceed its spool byte cap",
      );
    }
    const stats = await fs.promises.statfs(this.operationDirectory);
    const available = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isSafeInteger(available) || available < bytes + this.config.minFreeBytes) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_SPACE_EXHAUSTED",
        "Backup StateDirectory does not have enough reserved free space",
      );
    }
  }

  private async persistJournal(): Promise<void> {
    await this.assertMutationAuthority();
    const parsed = JournalSchema.parse(this.journal);
    const bytes = new TextEncoder().encode(JSON.stringify(parsed));
    if (bytes.byteLength > MAX_JOURNAL_BYTES) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_JOURNAL_TOO_LARGE",
        "Backup spool journal exceeds its byte limit",
      );
    }
    await this.preflightWrite(bytes.byteLength);
    await this.atomicReplace(JOURNAL_FILE, [bytes], MAX_JOURNAL_BYTES);
  }

  private async atomicReplace(
    fileName: string,
    parts: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<{ bytes: number; sha256: string }> {
    await this.assertMutationAuthority();
    const temporaryName = `.${fileName}.${bytesToHex(randomBytes(12))}.tmp`;
    const temporaryPath = path.join(this.operationDirectory, temporaryName);
    const finalPath = path.join(this.operationDirectory, fileName);
    const handle = await fs.promises.open(
      temporaryPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0),
      FILE_MODE,
    );
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      for await (const part of parts) {
        if (!(part instanceof Uint8Array) || part.byteLength === 0) {
          spoolError(
            "AGENT_BACKUP_V2_SPOOL_ZERO_PROGRESS",
            "Backup spool writer yielded an invalid empty fragment",
          );
        }
        if (bytes > maxBytes - part.byteLength) {
          spoolError(
            "AGENT_BACKUP_V2_SPOOL_ARTIFACT_TOO_LARGE",
            "Backup spool artifact exceeds its byte limit",
          );
        }
        let offset = 0;
        while (offset < part.byteLength) {
          const written = await handle.write(part, offset, part.byteLength - offset, null);
          if (written.bytesWritten === 0) {
            spoolError(
              "AGENT_BACKUP_V2_SPOOL_ZERO_PROGRESS",
              "Backup spool filesystem write made no progress",
            );
          }
          offset += written.bytesWritten;
        }
        hash.update(part);
        bytes += part.byteLength;
      }
      await handle.sync();
    } catch (cause) {
      // error-policy:J4 the incomplete create-only temporary file is safe to
      // remove; retain the originating write failure.
      await handle.close().catch(() => undefined);
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
      throw cause;
    }
    await handle.close();
    await this.assertMutationAuthority();
    await fs.promises.rename(temporaryPath, finalPath);
    await fsyncDirectory(this.operationDirectory);
    await this.assertMutationAuthority();
    return { bytes, sha256: hash.digest("hex") };
  }

  private async writeCreateOnlyArtifact(
    fileName: string,
    parts: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    expected: Readonly<{ bytes: number; sha256: string }>,
    maxBytes: number,
  ): Promise<void> {
    const finalPath = path.join(this.operationDirectory, fileName);
    const existing = await lstatRegularFile(finalPath);
    if (existing) {
      const observed = await hashFile(finalPath, maxBytes);
      if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) {
        spoolError(
          "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
          "Existing backup spool artifact differs from the exact replay",
        );
      }
      return;
    }
    await this.preflightWrite(expected.bytes);
    const written = await this.atomicReplace(fileName, parts, maxBytes);
    if (written.bytes !== expected.bytes || written.sha256 !== expected.sha256) {
      await this.assertMutationAuthority();
      await fs.promises.unlink(finalPath).catch(() => undefined);
      await fsyncDirectory(this.operationDirectory).catch(() => undefined);
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_DIGEST_MISMATCH",
        "Backup spool writer produced bytes different from declared metadata",
      );
    }
  }

  private async verifyCommittedAccounting(): Promise<void> {
    let committedBytes = 0;
    if (this.journal.operationKeyBundle) {
      committedBytes += this.journal.operationKeyBundle.bytes;
    }
    if (this.journal.manifest) committedBytes += this.journal.manifest.bytes;
    if (this.journal.catalogManifest) {
      committedBytes += this.journal.catalogManifest.bytes;
    }
    for (const chunk of this.journal.chunks) committedBytes += chunk.encryptedBytes;
    if (committedBytes !== this.journal.committedBytes) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_ACCOUNTING_INVALID",
        "Backup spool journal byte accounting is inconsistent",
      );
    }
    if (committedBytes > this.config.maxSpoolBytes) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_QUOTA_EXCEEDED",
        "Existing backup spool exceeds its configured byte cap",
      );
    }
  }

  async storeOperationKeyBundle(
    metadata: Readonly<
      Omit<AgentBackupCaptureV3OperationKeyBundleMetadata, "canonicalContextSha256">
    >,
    wrappedKeyBundle: Uint8Array,
  ): Promise<void> {
    await this.assertMutationAuthority();
    if (this.journal.phase !== "initialized" && this.journal.phase !== "capturing") {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_PHASE_INVALID",
        "Cannot replace an operation key bundle after manifest sealing",
      );
    }
    const ciphertextBase64 = Buffer.from(
      wrappedKeyBundle.buffer,
      wrappedKeyBundle.byteOffset,
      wrappedKeyBundle.byteLength,
    ).toString("base64");
    const parsed = OperationKeyBundleSchema.parse({
      ...metadata,
      canonicalContextSha256: sha256Hex(new TextEncoder().encode(metadata.canonicalContext)),
      ciphertextBase64,
    });
    if (
      wrappedKeyBundle.byteLength !== parsed.bytes ||
      sha256Hex(wrappedKeyBundle) !== parsed.sha256
    ) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_KEY_BUNDLE_INVALID",
        "Wrapped operation key bundle does not match its durable metadata",
      );
    }
    if (this.journal.operationKeyBundle) {
      if (JSON.stringify(this.journal.operationKeyBundle) !== JSON.stringify(parsed)) {
        spoolError(
          "AGENT_BACKUP_V3_SPOOL_REPLAY_CONFLICT",
          "Backup operation already owns a different operation key bundle",
        );
      }
      return;
    }
    this.journal.operationKeyBundle = parsed;
    this.journal.committedBytes += parsed.bytes;
    this.journal.phase = "capturing";
    await this.persistJournal();
  }

  getOperationKeyBundleMetadata():
    | Readonly<AgentBackupCaptureV3OperationKeyBundleMetadata>
    | undefined {
    const stored = this.journal.operationKeyBundle;
    if (!stored) return undefined;
    return Object.freeze({
      generationId: stored.generationId,
      format: stored.format,
      plaintextBytes: stored.plaintextBytes,
      nonceBytes: stored.nonceBytes,
      authTagBytes: stored.authTagBytes,
      bytes: stored.bytes,
      sha256: stored.sha256,
      localReceiptDerivation: stored.localReceiptDerivation,
      localReceiptDigest: stored.localReceiptDigest,
      canonicalContext: stored.canonicalContext,
      canonicalContextSha256: stored.canonicalContextSha256,
    });
  }

  async loadOperationKeyBundle(): Promise<Uint8Array> {
    await this.assertMutationAuthority();
    const metadata = this.journal.operationKeyBundle;
    if (!metadata) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_KEY_BUNDLE_MISSING",
        "Backup operation has no durable operation key bundle",
      );
    }
    const decoded = Buffer.from(metadata.ciphertextBase64, "base64");
    const bytes = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    try {
      if (bytes.byteLength !== metadata.bytes || sha256Hex(bytes) !== metadata.sha256) {
        spoolError(
          "AGENT_BACKUP_V3_SPOOL_KEY_BUNDLE_INVALID",
          "Durable operation key bundle failed size or digest verification",
        );
      }
      if (Buffer.from(bytes).toString("base64") !== metadata.ciphertextBase64) {
        spoolError(
          "AGENT_BACKUP_V3_SPOOL_KEY_BUNDLE_INVALID",
          "Durable operation key bundle is not canonical base64",
        );
      }
      if (
        sha256Hex(new TextEncoder().encode(metadata.canonicalContext)) !==
        metadata.canonicalContextSha256
      ) {
        spoolError(
          "AGENT_BACKUP_V3_SPOOL_KEY_BUNDLE_CONTEXT_INVALID",
          "Durable operation key-bundle context failed digest verification",
        );
      }
      return Uint8Array.from(bytes);
    } finally {
      bytes.fill(0);
    }
  }

  async storeCiphertextChunk(
    metadataInput: Readonly<AgentBackupCaptureV3SpoolChunk>,
    ciphertextParts: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  ): Promise<Readonly<AgentBackupCaptureV3SpoolChunk>> {
    await this.assertMutationAuthority();
    if (!this.journal.operationKeyBundle || this.journal.phase !== "capturing") {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_PHASE_INVALID",
        "Ciphertext chunks require an active capture and its operation key bundle",
      );
    }
    const file = chunkFile(metadataInput.component, metadataInput.index);
    const metadata = ChunkSchema.parse({ ...metadataInput, file });
    const existing = this.journal.chunks.find(
      (chunk) => chunk.component === metadata.component && chunk.index === metadata.index,
    );
    if (existing && !equalChunk(existing, metadata)) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
        "Backup chunk metadata changed while replaying one operation",
      );
    }
    await this.writeCreateOnlyArtifact(
      metadata.file,
      ciphertextParts,
      { bytes: metadata.encryptedBytes, sha256: metadata.ciphertextSha256 },
      metadata.encryptedBytes,
    );
    if (!existing) {
      this.journal.chunks.push(metadata);
      this.journal.chunks.sort(
        (left, right) =>
          compareCanonicalComponentNames(left.component, right.component) ||
          left.index - right.index,
      );
      this.journal.committedBytes += metadata.encryptedBytes;
      this.journal.phase = "capturing";
      await this.persistJournal();
    }
    return Object.freeze({ ...metadata });
  }

  /**
   * Recover the nonce from a fully renamed ciphertext artifact whose journal
   * commit was interrupted. Re-encrypting the same replay bytes with this nonce
   * lets `storeCiphertextChunk` verify and adopt the exact create-only artifact.
   */
  async loadCiphertextChunkNonceForReplay(
    componentInput: string,
    indexInput: number,
  ): Promise<Uint8Array | undefined> {
    await this.assertMutationAuthority();
    if (!this.journal.operationKeyBundle || this.journal.phase !== "capturing") {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_PHASE_INVALID",
        "Ciphertext replay nonce recovery requires an active capture",
      );
    }
    const identity = z
      .strictObject({
        component: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        index: ChunkIndexSchema,
      })
      .parse({ component: componentInput, index: indexInput });
    const committed = this.journal.chunks.find(
      (chunk) => chunk.component === identity.component && chunk.index === identity.index,
    );
    if (committed) return Uint8Array.from(Buffer.from(committed.nonceHex, "hex"));

    const filePath = path.join(
      this.operationDirectory,
      chunkFile(identity.component, identity.index),
    );
    const stat = await lstatRegularFile(filePath);
    if (!stat) return undefined;
    if (
      stat.size <
        AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes + AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes ||
      stat.size > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkEncryptedBytes
    ) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_ORPHAN_INVALID",
        "Interrupted ciphertext artifact has an invalid envelope length",
      );
    }
    const handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const nonce = new Uint8Array(AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes);
    let failure: unknown;
    try {
      const read = await handle.read(nonce, 0, nonce.byteLength, 0);
      if (read.bytesRead !== nonce.byteLength) {
        spoolError(
          "AGENT_BACKUP_V3_SPOOL_ORPHAN_INVALID",
          "Interrupted ciphertext artifact has a truncated nonce",
        );
      }
    } catch (cause) {
      failure = cause;
    }
    try {
      await handle.close();
    } catch (cause) {
      failure =
        failure === undefined
          ? cause
          : new AggregateError(
              [failure, cause],
              "Interrupted ciphertext nonce read and close both failed",
            );
    }
    if (failure !== undefined) {
      nonce.fill(0);
      throw failure;
    }
    return nonce;
  }

  async readCiphertextChunk(chunk: AgentBackupCaptureV3SpoolChunk): Promise<Uint8Array> {
    await this.assertMutationAuthority();
    const stored = this.journal.chunks.find(
      (candidate) => candidate.component === chunk.component && candidate.index === chunk.index,
    );
    if (!stored || !equalChunk(stored, chunk)) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_CHUNK_UNKNOWN",
        "Requested ciphertext chunk is not owned by this operation",
      );
    }
    const bytes = await readBoundedFile(
      path.join(this.operationDirectory, stored.file),
      stored.encryptedBytes,
    );
    if (
      bytes.byteLength !== stored.encryptedBytes ||
      sha256Hex(bytes) !== stored.ciphertextSha256
    ) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_CHUNK_INVALID",
        "Durable ciphertext chunk failed size or digest verification",
      );
    }
    return bytes;
  }

  async openCiphertextChunk(
    chunk: AgentBackupCaptureV3SpoolChunk,
  ): Promise<fs.promises.FileHandle> {
    await this.assertMutationAuthority();
    const stored = this.journal.chunks.find((candidate) => equalChunk(candidate, chunk));
    if (!stored) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_CHUNK_UNKNOWN",
        "Requested ciphertext chunk is not owned by this operation",
      );
    }
    return fs.promises.open(
      path.join(this.operationDirectory, stored.file),
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  }

  async sealManifest(
    manifestBytes: Uint8Array,
    metadataInput: Readonly<AgentBackupCaptureV3ManifestMetadata>,
  ): Promise<void> {
    await this.assertMutationAuthority();
    if (!this.journal.operationKeyBundle) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_KEY_BUNDLE_MISSING",
        "Cannot seal a v3 manifest without an operation key bundle",
      );
    }
    const metadata = ManifestSchema.parse({ file: MANIFEST_FILE, ...metadataInput });
    if (
      manifestBytes.byteLength !== metadata.bytes ||
      sha256Hex(manifestBytes) !== metadata.sha256
    ) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_MANIFEST_INVALID",
        "Canonical backup manifest does not match its durable metadata",
      );
    }
    if (
      this.journal.manifest &&
      JSON.stringify(this.journal.manifest) !== JSON.stringify(metadata)
    ) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
        "Backup operation already owns a different canonical manifest",
      );
    }
    if (!this.journal.manifest && this.journal.phase !== "capturing") {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_PHASE_INVALID",
        "A fresh manifest can only seal an active capture",
      );
    }
    await this.writeCreateOnlyArtifact(
      MANIFEST_FILE,
      [manifestBytes],
      metadata,
      MAX_MANIFEST_BYTES,
    );
    if (!this.journal.manifest) {
      this.journal.manifest = metadata;
      this.journal.committedBytes += metadata.bytes;
      this.journal.phase = "sealed";
      await this.persistJournal();
    }
  }

  async loadManifestBytes(): Promise<Uint8Array> {
    await this.assertMutationAuthority();
    const metadata = this.journal.manifest;
    if (!metadata) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_MANIFEST_MISSING",
        "Backup operation has no sealed manifest",
      );
    }
    const bytes = await readBoundedFile(
      path.join(this.operationDirectory, metadata.file),
      metadata.bytes,
    );
    if (bytes.byteLength !== metadata.bytes || sha256Hex(bytes) !== metadata.sha256) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_MANIFEST_INVALID",
        "Durable backup manifest failed size or digest verification",
      );
    }
    return bytes;
  }

  async markPublishing(): Promise<void> {
    await this.assertMutationAuthority();
    if (!this.journal.manifest) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_MANIFEST_MISSING",
        "Cannot publish an unsealed backup operation",
      );
    }
    if (this.journal.phase === "publishing" || this.journal.phase === "published") {
      return;
    }
    if (this.journal.phase !== "sealed") {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_PHASE_INVALID",
        "Primary publication can only begin from a sealed operation",
      );
    }
    this.journal.phase = "publishing";
    await this.persistJournal();
  }

  async markRecordCaptured(
    catalogManifestBytes: Uint8Array,
    metadataInput: Readonly<AgentBackupCaptureV3CatalogManifestMetadata>,
  ): Promise<void> {
    await this.assertMutationAuthority();
    if (!this.journal.manifest) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_MANIFEST_MISSING",
        "Cannot receipt a catalogue handoff without a sealed manifest",
      );
    }
    if (
      this.journal.phase !== "sealed" &&
      this.journal.phase !== "publishing" &&
      this.journal.phase !== "published"
    ) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_PHASE_INVALID",
        "Catalogue handoff requires a sealed backup operation",
      );
    }
    const metadata = CatalogManifestSchema.parse({
      file: CATALOG_MANIFEST_FILE,
      ...metadataInput,
    });
    if (
      catalogManifestBytes.byteLength !== metadata.bytes ||
      sha256Hex(catalogManifestBytes) !== metadata.sha256
    ) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_CATALOG_INVALID",
        "Catalogue handoff bytes differ from their durable metadata",
      );
    }
    if (
      this.journal.catalogManifest &&
      JSON.stringify(this.journal.catalogManifest) !== JSON.stringify(metadata)
    ) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_REPLAY_CONFLICT",
        "Backup operation already owns a different catalogue handoff",
      );
    }
    await this.writeCreateOnlyArtifact(
      CATALOG_MANIFEST_FILE,
      [catalogManifestBytes],
      metadata,
      MAX_CATALOG_MANIFEST_BYTES,
    );
    if (!this.journal.catalogManifest) {
      this.journal.catalogManifest = metadata;
      this.journal.committedBytes += metadata.bytes;
    }
    this.journal.recordCaptured = "confirmed";
    await this.persistJournal();
  }

  async loadCatalogManifestBytes(): Promise<Uint8Array> {
    await this.assertMutationAuthority();
    const metadata = this.journal.catalogManifest;
    if (this.journal.recordCaptured !== "confirmed" || !metadata) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_CATALOG_MISSING",
        "Backup operation has no confirmed catalogue handoff bytes",
      );
    }
    const bytes = await readBoundedFile(
      path.join(this.operationDirectory, metadata.file),
      metadata.bytes,
    );
    if (bytes.byteLength !== metadata.bytes || sha256Hex(bytes) !== metadata.sha256) {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_CATALOG_INVALID",
        "Durable catalogue handoff failed size or digest verification",
      );
    }
    return bytes;
  }

  async markChunkUploaded(chunk: AgentBackupCaptureV3SpoolChunk): Promise<void> {
    await this.assertMutationAuthority();
    if (this.journal.phase !== "publishing" && this.journal.phase !== "published") {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_PHASE_INVALID",
        "Chunk upload receipts require an active publication phase",
      );
    }
    const key = chunkKey(chunk);
    if (!this.journal.chunks.some((candidate) => equalChunk(candidate, chunk))) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_CHUNK_UNKNOWN",
        "Cannot receipt an unknown backup chunk upload",
      );
    }
    if (!this.journal.uploadedChunkKeys.includes(key)) {
      this.journal.uploadedChunkKeys.push(key);
      this.journal.uploadedChunkKeys.sort();
      await this.persistJournal();
    }
  }

  async markPublished(): Promise<void> {
    await this.assertMutationAuthority();
    if (this.journal.phase !== "publishing" && this.journal.phase !== "published") {
      spoolError(
        "AGENT_BACKUP_V3_SPOOL_PHASE_INVALID",
        "Published state requires an active publication phase",
      );
    }
    if (
      this.journal.recordCaptured !== "confirmed" ||
      this.journal.uploadedChunkKeys.length !== this.journal.chunks.length
    ) {
      spoolError(
        "AGENT_BACKUP_V2_SPOOL_PUBLISH_INCOMPLETE",
        "Backup publication receipts are incomplete",
      );
    }
    this.journal.phase = "published";
    await this.persistJournal();
  }

  /**
   * Explicit cleanup boundary. A failure returns `pending`; callers must retain
   * their durable cleanup/outbox intent and retry instead of recording success.
   * Production wiring must invoke this only from a catalogue-authorized janitor
   * after the backup is durably `protected`; `close()` is the handoff primitive.
   */
  async cleanup(): Promise<AgentBackupCaptureV3CleanupReceipt> {
    if (this.closed) {
      return {
        operationId: this.journal.operationId,
        status: this.cleanupComplete ? "complete" : "pending",
      };
    }
    const operationId = this.journal.operationId;
    try {
      await this.assertMutationAuthority();
      let operationExists = true;
      try {
        const stat = await fs.promises.lstat(this.operationDirectory);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          spoolError(
            "AGENT_BACKUP_V2_SPOOL_UNSAFE_ENTRY",
            "Backup spool cleanup target is not a safe directory",
          );
        }
      } catch (cause) {
        // error-policy:J2 an absent operation directory means an earlier
        // cleanup removed its artifacts before lock release; other errors stay.
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") operationExists = false;
        else throw cause;
      }
      if (operationExists) {
        const entries = (
          await fs.promises.readdir(this.operationDirectory, {
            withFileTypes: true,
          })
        ).sort((left, right) => {
          // Keep the journal as the last retry authority. A failed unlink of a
          // chunk/manifest can then be reopened and completed without guessing
          // which immutable operation owned the remaining artifacts.
          if (left.name === JOURNAL_FILE) return 1;
          if (right.name === JOURNAL_FILE) return -1;
          return left.name.localeCompare(right.name);
        });
        for (const entry of entries) {
          if (!entry.isFile() || entry.isSymbolicLink()) {
            spoolError(
              "AGENT_BACKUP_V2_SPOOL_UNSAFE_ENTRY",
              "Backup spool cleanup encountered an unsafe entry",
            );
          }
          await this.assertMutationAuthority();
          await fs.promises.unlink(path.join(this.operationDirectory, entry.name));
        }
        await fsyncDirectory(this.operationDirectory);
        await this.assertMutationAuthority();
        await fs.promises.rmdir(this.operationDirectory);
        await fsyncDirectory(this.namespaceDirectory);
      }
      await releaseSpoolLock(this.lock);
      this.closed = true;
      this.cleanupComplete = true;
      return { operationId, status: "complete" };
    } catch {
      // error-policy:J4 cleanup is a durable retry boundary. Keep ownership
      // and report pending instead of losing the only ciphertext evidence.
      return { operationId, status: "pending" };
    }
  }

  /** Release execution ownership without deleting replay artifacts. */
  async close(): Promise<void> {
    if (this.closed) return;
    await releaseSpoolLock(this.lock);
    this.closed = true;
  }
}
