/** Immutable payload ownership journals, replay, and streaming writer. */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateFsControl,
  AgentBackupRestoreV3CandidateFsError,
  type AgentBackupRestoreV3CandidateFsIdentity,
  type AgentBackupRestoreV3CandidateFsLock,
  assertActive,
  assertBoundFile,
  boundedInternalCleanup,
  CANDIDATE_FS_IO_CHUNK_BYTES,
  type CandidateFsExactStats,
  candidateFsError,
  candidateFsIdentity,
  controlled,
  controlledAcquire,
  fileStatExact,
  internalCleanupControl,
  isErrno,
  lstatExact,
  requireControlName,
  requirePositiveSafeInteger,
  requirePrivateSingleLinkFile,
  sameStableFile,
  syncDirectory,
  writeAll,
} from "./agent-backup-restore-v3-candidate-fs-control";
import {
  publishCandidateFsDurableJson,
  readCandidateFsCanonicalJson,
} from "./agent-backup-restore-v3-candidate-fs-json";

const MAX_UINT64 = 18_446_744_073_709_551_615n;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UINT64_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const PAYLOAD_OWNER_TOKEN_MINIMUM_BYTES = 32;

export interface AgentBackupRestoreV3CandidatePayloadReceipt
  extends AgentBackupRestoreV3CandidateFsIdentity {
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface CreateAgentBackupRestoreV3CandidatePayloadOptions {
  readonly maximumBytes: number;
  /** Stable, secret attempt-scoped token used to recover response loss. */
  readonly ownerToken: string;
}

export interface ProveAgentBackupRestoreV3CandidatePayloadOptions {
  readonly maximumBytes: number;
}

interface PayloadOwnerJournal {
  readonly version: 1;
  readonly name: string;
  readonly ownerTokenSha256: string;
  readonly maximumBytes: number;
}

interface PayloadReceiptJournal extends PayloadOwnerJournal {
  readonly receipt: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>;
}

interface PayloadIdentityJournal extends PayloadOwnerJournal {
  readonly device: string;
  readonly inode: string;
}

function parsePayloadReceipt(
  value: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>,
  maximumBytes: number,
): Readonly<AgentBackupRestoreV3CandidatePayloadReceipt> {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    value.sizeBytes > maximumBytes ||
    !SHA256_PATTERN.test(value.sha256) ||
    !UINT64_PATTERN.test(value.device) ||
    BigInt(value.device) > MAX_UINT64 ||
    !UINT64_PATTERN.test(value.inode) ||
    BigInt(value.inode) > MAX_UINT64
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
      "Candidate payload receipt is not exact and canonical",
    );
  }
  return Object.freeze({ ...value });
}

function ownerTokenSha256(value: string): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") < PAYLOAD_OWNER_TOKEN_MINIMUM_BYTES ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_INVALID",
      "Candidate payload owner token must be a bounded attempt-scoped secret",
    );
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function payloadJournalNames(name: string): {
  readonly owner: string;
  readonly identity: string;
  readonly receipt: string;
} {
  const derivation = createHash("sha256").update(name, "utf8").digest("hex");
  return Object.freeze({
    owner: `.payload-${derivation.slice(0, 32)}.owner.json`,
    identity: `.payload-${derivation.slice(0, 32)}.identity.json`,
    receipt: `.payload-${derivation.slice(0, 32)}.receipt.json`,
  });
}

function parseIdentityJournal(
  value: unknown,
  expected: PayloadOwnerJournal,
): Readonly<PayloadIdentityJournal> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
      "Candidate payload identity journal is not canonical",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join("\0") !==
      [
        "device",
        "inode",
        "maximumBytes",
        "name",
        "ownerTokenSha256",
        "version",
      ].join("\0") ||
    record.version !== 1 ||
    record.name !== expected.name ||
    record.ownerTokenSha256 !== expected.ownerTokenSha256 ||
    record.maximumBytes !== expected.maximumBytes ||
    typeof record.device !== "string" ||
    !UINT64_PATTERN.test(record.device) ||
    BigInt(record.device) > MAX_UINT64 ||
    typeof record.inode !== "string" ||
    !UINT64_PATTERN.test(record.inode) ||
    BigInt(record.inode) > MAX_UINT64
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
      "Candidate payload identity belongs to another owner, contract, or inode",
    );
  }
  return Object.freeze({
    ...expected,
    device: record.device,
    inode: record.inode,
  });
}

function parseOwnerJournal(
  value: unknown,
  expected: PayloadOwnerJournal,
): Readonly<PayloadOwnerJournal> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_CONFLICT",
      "Candidate payload owner journal is not canonical",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join("\0") !==
      ["maximumBytes", "name", "ownerTokenSha256", "version"].join("\0") ||
    record.version !== 1 ||
    record.name !== expected.name ||
    record.ownerTokenSha256 !== expected.ownerTokenSha256 ||
    record.maximumBytes !== expected.maximumBytes
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_CONFLICT",
      "Candidate payload path is already claimed by another owner or contract",
    );
  }
  return Object.freeze({ ...expected });
}

function parseReceiptJournal(
  value: unknown,
  expected: PayloadOwnerJournal,
): Readonly<PayloadReceiptJournal> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
      "Candidate payload receipt journal is not canonical",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join("\0") !==
      ["maximumBytes", "name", "ownerTokenSha256", "receipt", "version"].join(
        "\0",
      ) ||
    record.version !== 1 ||
    record.name !== expected.name ||
    record.ownerTokenSha256 !== expected.ownerTokenSha256 ||
    record.maximumBytes !== expected.maximumBytes
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_CONFLICT",
      "Candidate payload receipt belongs to another owner or contract",
    );
  }
  const receipt = parsePayloadReceipt(
    record.receipt as Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>,
    expected.maximumBytes,
  );
  return Object.freeze({ ...expected, receipt });
}

async function proveOpenedPayload(
  handle: FileHandle,
  filePath: string,
  expectedIdentity: CandidateFsExactStats,
  maximumBytes: number,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>> {
  const before = await assertBoundFile(
    handle,
    filePath,
    expectedIdentity,
    control,
  );
  if (before.size > maximumBytes) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_LIMIT",
      "Candidate payload exceeds its explicit byte bound",
    );
  }
  const hash = createHash("sha256");
  const chunk = new Uint8Array(
    Math.min(CANDIDATE_FS_IO_CHUNK_BYTES, Math.max(1, before.size)),
  );
  let position = 0;
  try {
    while (position < before.size) {
      const requested = Math.min(chunk.byteLength, before.size - position);
      const read = await controlled(
        () => handle.read(chunk, 0, requested, position),
        control,
      );
      if (read.bytesRead <= 0) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_TRUNCATED",
          "Candidate payload ended before its bound descriptor size",
        );
      }
      hash.update(chunk.subarray(0, read.bytesRead));
      chunk.fill(0, 0, read.bytesRead);
      position += read.bytesRead;
    }
  } finally {
    chunk.fill(0);
  }
  const after = await assertBoundFile(
    handle,
    filePath,
    expectedIdentity,
    control,
  );
  if (!sameStableFile(before, after)) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
      "Candidate payload changed while it was proved",
    );
  }
  return Object.freeze({
    ...candidateFsIdentity(after),
    sizeBytes: after.size,
    sha256: hash.digest("hex"),
  });
}

async function provePayloadUnlocked(
  authority: AgentBackupRestoreV3CandidateFsControl,
  name: string,
  maximumBytes: number,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>> {
  const payloadPath = authority.directPath(name, "payload name");
  let handle: FileHandle;
  try {
    handle = await controlledAcquire(
      () => fs.open(payloadPath, constants.O_RDONLY | constants.O_NOFOLLOW),
      (lateHandle) => lateHandle.close(),
      control,
    );
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
        "Candidate payload replay is absent",
      );
    }
    throw cause;
  }
  try {
    const opened = await controlled(() => fileStatExact(handle), control);
    requirePrivateSingleLinkFile(
      opened,
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
      "Candidate payload replay is not one private regular file",
    );
    return await proveOpenedPayload(
      handle,
      payloadPath,
      opened,
      maximumBytes,
      control,
    );
  } finally {
    await boundedInternalCleanup(() => handle.close());
  }
}

export class AgentBackupRestoreV3CandidatePayloadWriter {
  readonly name: string;
  #owner: AgentBackupRestoreV3CandidateFsControl;
  #path: string;
  #handle: FileHandle | null;
  #identity: CandidateFsExactStats | null;
  #maximumBytes: number;
  #position: number;
  #ownerJournal: PayloadOwnerJournal;
  #receiptJournalName: string;
  #lock: AgentBackupRestoreV3CandidateFsLock;
  #ownsLock: boolean;
  #replayedReceipt: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt> | null;
  #writing = false;
  #closed = false;

  constructor(input: {
    owner: AgentBackupRestoreV3CandidateFsControl;
    name: string;
    path: string;
    handle: FileHandle | null;
    identity: CandidateFsExactStats | null;
    maximumBytes: number;
    position: number;
    ownerJournal: PayloadOwnerJournal;
    receiptJournalName: string;
    lock: AgentBackupRestoreV3CandidateFsLock;
    ownsLock: boolean;
    replayedReceipt?: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>;
  }) {
    this.#owner = input.owner;
    this.name = input.name;
    this.#path = input.path;
    this.#handle = input.handle;
    this.#identity = input.identity;
    this.#maximumBytes = input.maximumBytes;
    this.#position = input.position;
    this.#ownerJournal = input.ownerJournal;
    this.#receiptJournalName = input.receiptJournalName;
    this.#lock = input.lock;
    this.#ownsLock = input.ownsLock;
    this.#replayedReceipt = input.replayedReceipt ?? null;
  }

  get acknowledgedBytes(): number {
    return this.#position;
  }

  write(
    fragment: Uint8Array,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    if (!(fragment instanceof Uint8Array) || fragment.byteLength === 0) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FRAGMENT_INVALID",
        "Candidate payload requires one non-empty byte fragment",
      );
    }
    if (fragment.byteLength > CANDIDATE_FS_IO_CHUNK_BYTES) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FRAGMENT_LIMIT",
        "Candidate payload fragment exceeds 256 KiB",
      );
    }
    if (
      this.#closed ||
      this.#writing ||
      !this.#handle ||
      !this.#identity ||
      this.#replayedReceipt
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_STATE_INVALID",
        "Candidate payload writer is closed or already writing",
      );
    }
    if (this.#position > this.#maximumBytes - fragment.byteLength) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_LIMIT",
        "Candidate payload exceeds its explicit byte bound",
      );
    }
    const owned = Uint8Array.from(fragment);
    this.#writing = true;
    return (async () => {
      try {
        await this.#owner.assertLockHeld(this.#lock, control);
        await assertBoundFile(
          this.#handle as FileHandle,
          this.#path,
          this.#identity as CandidateFsExactStats,
          control,
        );
        await this.#owner.assertLockHeld(this.#lock, control);
        await writeAll(
          this.#handle as FileHandle,
          owned,
          this.#position,
          control,
        );
        this.#position += owned.byteLength;
        await assertBoundFile(
          this.#handle as FileHandle,
          this.#path,
          this.#identity as CandidateFsExactStats,
          control,
        );
        await this.#owner.assertLockHeld(this.#lock, control);
      } catch (cause) {
        this.#closed = true;
        try {
          await this.#disposeResources();
        } catch (cleanupCause) {
          throw new AgentBackupRestoreV3CandidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_CLEANUP_FAILED",
            "Candidate payload write failed and its descriptor or kernel lock could not be disposed",
            { cause: new AggregateError([cause, cleanupCause]) },
          );
        }
        throw cause;
      } finally {
        owned.fill(0);
        this.#writing = false;
      }
    })();
  }

  async finalize(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>> {
    if (this.#closed || this.#writing) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_STATE_INVALID",
        "Candidate payload writer cannot finalize in its current state",
      );
    }
    this.#closed = true;
    let primaryFailure: unknown;
    let result: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt> | null =
      null;
    try {
      await this.#owner.assertLockHeld(this.#lock, control);
      if (this.#replayedReceipt) {
        result = this.#replayedReceipt;
      } else {
        if (!this.#handle || !this.#identity) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_STATE_INVALID",
            "Candidate payload writer lost its bound descriptor",
          );
        }
        await controlled(() => (this.#handle as FileHandle).sync(), control);
        const receipt = await proveOpenedPayload(
          this.#handle as FileHandle,
          this.#path,
          this.#identity as CandidateFsExactStats,
          this.#maximumBytes,
          control,
        );
        if (receipt.sizeBytes !== this.#position) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
            "Candidate payload size differs from this writer's acknowledged bytes",
          );
        }
        await publishCandidateFsDurableJson(
          this.#owner,
          this.#receiptJournalName,
          { ...this.#ownerJournal, receipt },
          { maximumBytes: 4_096 },
          control,
          this.#lock,
        );
        await this.#owner.syncAttemptRoot(control);
        result = receipt;
      }
    } catch (cause) {
      primaryFailure = cause;
    }
    try {
      await this.#disposeResources();
    } catch (cleanupCause) {
      if (primaryFailure !== undefined) {
        throw new AgentBackupRestoreV3CandidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_CLEANUP_FAILED",
          "Candidate payload finalization and resource cleanup both failed",
          { cause: new AggregateError([primaryFailure, cleanupCause]) },
        );
      }
      throw cleanupCause;
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (!result) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_STATE_INVALID",
        "Candidate payload finalization ended without an exact receipt",
      );
    }
    return result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#writing) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_STATE_INVALID",
        "Candidate payload writer cannot close during a write",
      );
    }
    this.#closed = true;
    await this.#disposeResources();
  }

  async #disposeResources(): Promise<void> {
    let firstFailure: unknown;
    const handle = this.#handle;
    this.#handle = null;
    if (handle) {
      try {
        await boundedInternalCleanup(() => handle.close());
      } catch (cause) {
        firstFailure = cause;
      }
    }
    const lock = this.#lock;
    if (this.#ownsLock) {
      this.#ownsLock = false;
      try {
        await lock.release(internalCleanupControl());
      } catch (cause) {
        if (firstFailure !== undefined) {
          throw new AggregateError([firstFailure, cause]);
        }
        throw cause;
      }
    }
    if (firstFailure !== undefined) throw firstFailure;
  }
}

export async function createCandidateFsPayload(
  authority: AgentBackupRestoreV3CandidateFsControl,
  name: string,
  options: Readonly<CreateAgentBackupRestoreV3CandidatePayloadOptions>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<AgentBackupRestoreV3CandidatePayloadWriter> {
  const maximumBytes = requirePositiveSafeInteger(
    options?.maximumBytes,
    "maximumBytes",
  );
  const ownerSha256 = ownerTokenSha256(options?.ownerToken);
  const ownerJournal: PayloadOwnerJournal = Object.freeze({
    version: 1,
    name: requireControlName(name, "payload name"),
    ownerTokenSha256: ownerSha256,
    maximumBytes,
  });
  const journalNames = payloadJournalNames(name);
  const payloadPath = authority.directPath(name, "payload name");
  await authority.assertAuthority(control);
  const operationLock = await authority.operationLock(
    `.payload-${ownerSha256.slice(0, 16)}`,
    control,
    heldLock,
  );
  const activeLock = operationLock ?? heldLock;
  if (!activeLock) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
      "Candidate payload did not obtain an exact inode-lock lease",
    );
  }
  let handle: FileHandle | null = null;
  try {
    await authority.syncAttemptRoot(control);
    const existingOwner = await readCandidateFsCanonicalJson(
      authority,
      journalNames.owner,
      4_096,
      control,
    );
    if (existingOwner === null) {
      try {
        await controlled(() => lstatExact(payloadPath), control);
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
          "Candidate payload exists without its durable owner journal",
        );
      } catch (cause) {
        if (!isErrno(cause, "ENOENT")) throw cause;
      }
      await publishCandidateFsDurableJson(
        authority,
        journalNames.owner,
        ownerJournal,
        { maximumBytes: 4_096 },
        control,
        activeLock,
      );
    } else {
      parseOwnerJournal(existingOwner, ownerJournal);
    }

    const existingIdentity = await readCandidateFsCanonicalJson(
      authority,
      journalNames.identity,
      4_096,
      control,
    );
    const identityJournal =
      existingIdentity === null
        ? null
        : parseIdentityJournal(existingIdentity, ownerJournal);
    const existingReceipt = await readCandidateFsCanonicalJson(
      authority,
      journalNames.receipt,
      4_096,
      control,
    );
    if (existingReceipt !== null) {
      if (!identityJournal) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
          "Candidate payload receipt exists without its immutable inode journal",
        );
      }
      const receiptJournal = parseReceiptJournal(existingReceipt, ownerJournal);
      const proved = await provePayloadUnlocked(
        authority,
        name,
        maximumBytes,
        control,
      );
      if (
        proved.sizeBytes !== receiptJournal.receipt.sizeBytes ||
        proved.sha256 !== receiptJournal.receipt.sha256 ||
        proved.device !== receiptJournal.receipt.device ||
        proved.inode !== receiptJournal.receipt.inode ||
        proved.device !== identityJournal.device ||
        proved.inode !== identityJournal.inode
      ) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
          "Candidate payload differs from its durable owner receipt",
        );
      }
      await authority.assertLockHeld(activeLock, control);
      return new AgentBackupRestoreV3CandidatePayloadWriter({
        owner: authority,
        name,
        path: payloadPath,
        handle: null,
        identity: null,
        maximumBytes,
        position: proved.sizeBytes,
        ownerJournal,
        receiptJournalName: journalNames.receipt,
        lock: activeLock,
        ownsLock: operationLock !== null,
        replayedReceipt: proved,
      });
    }

    if (!identityJournal) {
      let orphanHandle: FileHandle | null = null;
      try {
        orphanHandle = await controlledAcquire(
          () => fs.open(payloadPath, constants.O_RDWR | constants.O_NOFOLLOW),
          (lateHandle) => lateHandle.close(),
          control,
        );
        const orphanStats = await controlled(
          () => fileStatExact(orphanHandle as FileHandle),
          control,
        );
        requirePrivateSingleLinkFile(
          orphanStats,
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
          "Candidate payload without an inode journal is not safe to discard",
        );
        await assertBoundFile(orphanHandle, payloadPath, orphanStats, control);
        assertActive(control);
        await fs.unlink(payloadPath);
        await boundedInternalCleanup(async () => {
          await (orphanHandle as FileHandle).close();
          orphanHandle = null;
          await syncDirectory(
            authority.attemptAuthority,
            internalCleanupControl(),
          );
        });
      } catch (cause) {
        if (!isErrno(cause, "ENOENT")) throw cause;
      } finally {
        if (orphanHandle) {
          await boundedInternalCleanup(() =>
            (orphanHandle as FileHandle).close(),
          );
        }
      }
    }

    if (identityJournal) {
      try {
        handle = await controlledAcquire(
          () => fs.open(payloadPath, constants.O_RDWR | constants.O_NOFOLLOW),
          (lateHandle) => lateHandle.close(),
          control,
        );
      } catch (cause) {
        if (isErrno(cause, "ENOENT")) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
            "Candidate payload inode journal exists but its payload is absent",
          );
        }
        throw cause;
      }
    } else {
      handle = await controlledAcquire(
        () =>
          fs.open(
            payloadPath,
            constants.O_CREAT |
              constants.O_EXCL |
              constants.O_RDWR |
              constants.O_NOFOLLOW,
            0o600,
          ),
        (lateHandle) => lateHandle.close(),
        control,
      );
    }
    const opened = await controlled(
      () => fileStatExact(handle as FileHandle),
      control,
    );
    requirePrivateSingleLinkFile(
      opened,
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
      "Candidate payload is not one private regular file",
    );
    if (opened.size > maximumBytes) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_LIMIT",
        "Candidate payload resume exceeds its explicit byte bound",
      );
    }
    if (
      identityJournal &&
      (opened.device.toString(10) !== identityJournal.device ||
        opened.inode.toString(10) !== identityJournal.inode)
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
        "Candidate payload inode changed after its immutable owner binding",
      );
    }
    await assertBoundFile(handle as FileHandle, payloadPath, opened, control);
    await authority.syncAttemptRoot(control);
    if (!identityJournal) {
      await publishCandidateFsDurableJson(
        authority,
        journalNames.identity,
        { ...ownerJournal, ...candidateFsIdentity(opened) },
        { maximumBytes: 4_096 },
        control,
        activeLock,
      );
    }
    const writer = new AgentBackupRestoreV3CandidatePayloadWriter({
      owner: authority,
      name,
      path: payloadPath,
      handle: handle as FileHandle,
      identity: opened,
      maximumBytes,
      position: opened.size,
      ownerJournal,
      receiptJournalName: journalNames.receipt,
      lock: activeLock,
      ownsLock: operationLock !== null,
    });
    await authority.assertLockHeld(activeLock, control);
    handle = null;
    return writer;
  } catch (cause) {
    const handleToClose = handle;
    if (handleToClose) {
      await boundedInternalCleanup(() => handleToClose.close());
    }
    if (operationLock) {
      await operationLock.release(internalCleanupControl());
    }
    throw cause;
  }
}

export async function proveCandidateFsPayload(
  authority: AgentBackupRestoreV3CandidateFsControl,
  name: string,
  expectedValue: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>,
  options: Readonly<ProveAgentBackupRestoreV3CandidatePayloadOptions>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>> {
  const maximumBytes = requirePositiveSafeInteger(
    options?.maximumBytes,
    "maximumBytes",
  );
  const expected = parsePayloadReceipt(expectedValue, maximumBytes);
  await authority.assertAuthority(control);
  const operationLock = await authority.operationLock(
    `.prove-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`,
    control,
    heldLock,
  );
  const activeLock = operationLock ?? heldLock;
  if (!activeLock) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
      "Candidate payload proof did not obtain an exact inode-lock lease",
    );
  }
  try {
    await authority.assertLockHeld(activeLock, control);
    const receipt = await provePayloadUnlocked(
      authority,
      name,
      maximumBytes,
      control,
    );
    if (
      receipt.sizeBytes !== expected.sizeBytes ||
      receipt.sha256 !== expected.sha256 ||
      receipt.device !== expected.device ||
      receipt.inode !== expected.inode
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
        "Candidate payload replay differs from its exact receipt",
      );
    }
    await authority.assertLockHeld(activeLock, control);
    return receipt;
  } finally {
    if (operationLock) {
      await operationLock.release(internalCleanupControl());
    }
  }
}
