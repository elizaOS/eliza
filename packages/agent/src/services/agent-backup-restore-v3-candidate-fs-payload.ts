/** Immutable payload ownership journals, replay, and streaming writer. */

import { type BinaryLike, createHash, Hash } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { types as utilTypes } from "node:util";
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
  candidateFsByteView,
  candidateFsError,
  candidateFsIdentity,
  candidateFsNativeIoView,
  controlled,
  controlledAcquire,
  fileStatExact,
  internalCleanupControl,
  isErrno,
  lstatExact,
  requireControlName,
  requirePositiveSafeInteger,
  requirePrivateSingleLinkFile,
  runAllBoundedInternalCleanup,
  sameStableFile,
  snapshotOperationControl,
  snapshotOwnDataRecord,
  syncDirectory,
  writeAll,
} from "./agent-backup-restore-v3-candidate-fs-control";
import {
  publishCandidateFsDurableJson,
  readCandidateFsCanonicalJson,
  readCandidateFsCanonicalJsonReadOnly,
} from "./agent-backup-restore-v3-candidate-fs-json";

const MAX_UINT64 = 18_446_744_073_709_551_615n;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UINT64_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const PAYLOAD_OWNER_TOKEN_MINIMUM_BYTES = 32;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_IS = Object.is;
const OBJECT_KEYS = Object.keys;
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_JOIN = Array.prototype.join;
const ARRAY_SORT = Array.prototype.sort;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const REFLECT_APPLY = Reflect.apply;
const CREATE_HASH = createHash;
const HASH_UPDATE = Hash.prototype.update as (
  data: BinaryLike,
  inputEncoding?: BufferEncoding,
) => Hash;
const HASH_DIGEST_HEX = Hash.prototype.digest as (encoding: "hex") => string;
const HASH_COPY = Hash.prototype.copy as () => Hash;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const IS_PROXY = utilTypes.isProxy;
const IS_UINT8_ARRAY = utilTypes.isUint8Array;
const STRING_SLICE = String.prototype.slice;
const EMPTY_PAYLOAD_SHA256 = hashDigestHex(createSha256Hash());

function createSha256Hash(): Hash {
  return CREATE_HASH("sha256");
}

function updateHash(
  hash: Hash,
  data: BinaryLike,
  inputEncoding?: BufferEncoding,
): Hash {
  if (inputEncoding === undefined) {
    return REFLECT_APPLY(HASH_UPDATE, hash, [data]);
  }
  return REFLECT_APPLY(HASH_UPDATE, hash, [data, inputEncoding]);
}

function hashDigestHex(hash: Hash): string {
  return REFLECT_APPLY(HASH_DIGEST_HEX, hash, ["hex"]);
}

function copyHash(hash: Hash): Hash {
  return REFLECT_APPLY(HASH_COPY, hash, []);
}

function sha256Hex(data: BinaryLike, inputEncoding?: BufferEncoding): string {
  return hashDigestHex(updateHash(createSha256Hash(), data, inputEncoding));
}

function sortedObjectKeys(value: object): string[] {
  return REFLECT_APPLY(ARRAY_SORT, OBJECT_KEYS(value), []);
}

function joinStrings(value: readonly string[], separator: string): string {
  return REFLECT_APPLY(ARRAY_JOIN, value, [separator]);
}

function hasExactKeys(
  value: readonly string[],
  expected: readonly string[],
): boolean {
  return joinStrings(value, "\0") === joinStrings(expected, "\0");
}

function stringSlice(value: string, start: number, end?: number): string {
  return REFLECT_APPLY(
    STRING_SLICE,
    value,
    end === undefined ? [start] : [start, end],
  );
}

function typedArrayByteLength(value: Uint8Array): number {
  return REFLECT_APPLY(
    TYPED_ARRAY_BYTE_LENGTH_GETTER as () => number,
    value,
    [],
  );
}

function zeroBytes(value: Uint8Array, start?: number, end?: number): void {
  REFLECT_APPLY(
    UINT8_ARRAY_FILL,
    value,
    end === undefined
      ? start === undefined
        ? [0]
        : [0, start]
      : [0, start, end],
  );
}

function payloadFragmentByteLength(fragment: Uint8Array): number {
  if (
    !IS_UINT8_ARRAY(fragment) ||
    !TYPED_ARRAY_BYTE_LENGTH_GETTER ||
    !TYPED_ARRAY_BUFFER_GETTER ||
    !ARRAY_BUFFER_BYTE_LENGTH_GETTER
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FRAGMENT_INVALID",
      "Candidate payload byte-array contract is unavailable",
    );
  }
  try {
    const buffer = REFLECT_APPLY(TYPED_ARRAY_BUFFER_GETTER, fragment, []);
    // The ArrayBuffer intrinsic rejects SharedArrayBuffer. A shared backing
    // store could otherwise change concurrently and yield a torn snapshot.
    REFLECT_APPLY(ARRAY_BUFFER_BYTE_LENGTH_GETTER, buffer, []);
    return typedArrayByteLength(fragment);
  } catch (cause) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FRAGMENT_INVALID",
      "Candidate payload requires one native byte array",
      { cause },
    );
  }
}

function copyPayloadFragment(
  fragment: Uint8Array,
  byteLength: number,
): Uint8Array {
  const owned = new INTRINSIC_UINT8_ARRAY(byteLength);
  try {
    // Invoke the intrinsic typed-array copy path. Uint8Array.from and the
    // public iterator are caller-controlled and may disagree with byteLength.
    REFLECT_APPLY(UINT8_ARRAY_SET, owned, [fragment]);
  } catch (cause) {
    zeroBytes(owned);
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FRAGMENT_INVALID",
      "Candidate payload fragment could not be copied exactly",
      { cause },
    );
  }
  return owned;
}

export interface AgentBackupRestoreV3CandidatePayloadReceipt
  extends AgentBackupRestoreV3CandidateFsIdentity {
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface CreateAgentBackupRestoreV3CandidatePayloadOptions {
  readonly maximumBytes: number;
  /** Stable owner-owned binary capability used to recover response loss. */
  readonly ownerToken: Uint8Array;
}

export interface ProveAgentBackupRestoreV3CandidatePayloadOptions {
  readonly maximumBytes: number;
}

export interface ReadAgentBackupRestoreV3CandidatePayloadOptions {
  /** Atomic in-memory reads are deliberately limited to one I/O chunk. */
  readonly maximumBytes: number;
  /** Stable owner-owned binary capability; only its digest is persisted. */
  readonly ownerToken: Uint8Array;
}

export interface AgentBackupRestoreV3CandidatePayloadRead {
  readonly receipt: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>;
  /** Caller-owned copy. The caller is responsible for zeroizing it. */
  readonly payload: Uint8Array;
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

interface PayloadCheckpointJournal extends PayloadIdentityJournal {
  readonly generation: number;
  readonly acknowledgedBytes: number;
  readonly prefixSha256: string;
}

function parsePayloadReceipt(
  value: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>,
  maximumBytes: number,
): Readonly<AgentBackupRestoreV3CandidatePayloadReceipt> {
  const snapshot = snapshotOwnDataRecord(
    value,
    ["sizeBytes", "sha256", "device", "inode"],
    ["sizeBytes", "sha256", "device", "inode"],
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
    "Candidate payload receipt is not exact and canonical",
  );
  if (
    !Number.isSafeInteger(snapshot.sizeBytes) ||
    (snapshot.sizeBytes as number) < 0 ||
    (snapshot.sizeBytes as number) > maximumBytes ||
    typeof snapshot.sha256 !== "string" ||
    !SHA256_PATTERN.test(snapshot.sha256) ||
    typeof snapshot.device !== "string" ||
    !UINT64_PATTERN.test(snapshot.device) ||
    BigInt(snapshot.device) > MAX_UINT64 ||
    typeof snapshot.inode !== "string" ||
    !UINT64_PATTERN.test(snapshot.inode) ||
    BigInt(snapshot.inode) > MAX_UINT64
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
      "Candidate payload receipt is not exact and canonical",
    );
  }
  return OBJECT_FREEZE({
    sizeBytes: snapshot.sizeBytes as number,
    sha256: snapshot.sha256 as string,
    device: snapshot.device as string,
    inode: snapshot.inode as string,
  });
}

function ownerTokenSha256(value: Uint8Array): string {
  if (
    IS_PROXY(value) ||
    !IS_UINT8_ARRAY(value) ||
    OBJECT_GET_PROTOTYPE_OF(value) !== INTRINSIC_UINT8_ARRAY.prototype ||
    !TYPED_ARRAY_BYTE_LENGTH_GETTER ||
    !TYPED_ARRAY_BUFFER_GETTER ||
    !ARRAY_BUFFER_BYTE_LENGTH_GETTER
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_INVALID",
      "Candidate payload owner capability must be one bounded exact Uint8Array",
    );
  }
  let byteLength: number;
  try {
    const buffer = REFLECT_APPLY(TYPED_ARRAY_BUFFER_GETTER, value, []);
    REFLECT_APPLY(ARRAY_BUFFER_BYTE_LENGTH_GETTER, buffer, []);
    byteLength = typedArrayByteLength(value);
  } catch (cause) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_INVALID",
      "Candidate payload owner capability requires private non-shared storage",
      { cause },
    );
  }
  if (byteLength < PAYLOAD_OWNER_TOKEN_MINIMUM_BYTES || byteLength > 512) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_INVALID",
      "Candidate payload owner capability must be one bounded exact Uint8Array",
    );
  }
  const owned = new INTRINSIC_UINT8_ARRAY(byteLength);
  try {
    REFLECT_APPLY(UINT8_ARRAY_SET, owned, [value]);
  } catch (cause) {
    zeroBytes(owned);
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_INVALID",
      "Candidate payload owner capability could not be copied exactly",
      { cause },
    );
  }
  try {
    return sha256Hex(candidateFsNativeIoView(owned));
  } finally {
    zeroBytes(owned);
  }
}

function payloadJournalNames(name: string): {
  readonly owner: string;
  readonly identity: string;
  readonly receipt: string;
  readonly checkpoints: readonly [string, string];
} {
  const derivation = sha256Hex(name, "utf8");
  const prefix = `.payload-${stringSlice(derivation, 0, 32)}`;
  return OBJECT_FREEZE({
    owner: `${prefix}.owner.json`,
    identity: `${prefix}.identity.json`,
    receipt: `${prefix}.receipt.json`,
    checkpoints: OBJECT_FREEZE([
      `${prefix}.checkpoint-0.json`,
      `${prefix}.checkpoint-1.json`,
    ]) as readonly [string, string],
  });
}

function parseCheckpointJournal(
  value: unknown,
  expected: PayloadIdentityJournal,
  slot: number,
): Readonly<PayloadCheckpointJournal> {
  if (
    !value ||
    typeof value !== "object" ||
    ARRAY_IS_ARRAY(value) ||
    OBJECT_GET_PROTOTYPE_OF(value) !== OBJECT_PROTOTYPE
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
      "Candidate payload checkpoint is not canonical",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = sortedObjectKeys(record);
  if (
    !hasExactKeys(keys, [
      "acknowledgedBytes",
      "device",
      "generation",
      "inode",
      "maximumBytes",
      "name",
      "ownerTokenSha256",
      "prefixSha256",
      "version",
    ]) ||
    record.version !== 1 ||
    record.name !== expected.name ||
    record.ownerTokenSha256 !== expected.ownerTokenSha256 ||
    record.maximumBytes !== expected.maximumBytes ||
    record.device !== expected.device ||
    record.inode !== expected.inode ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 0 ||
    OBJECT_IS(record.generation, -0) ||
    (record.generation as number) % 2 !== slot ||
    !Number.isSafeInteger(record.acknowledgedBytes) ||
    (record.acknowledgedBytes as number) < 0 ||
    (record.acknowledgedBytes as number) > expected.maximumBytes ||
    OBJECT_IS(record.acknowledgedBytes, -0) ||
    typeof record.prefixSha256 !== "string" ||
    !SHA256_PATTERN.test(record.prefixSha256) ||
    ((record.generation as number) === 0 &&
      ((record.acknowledgedBytes as number) !== 0 ||
        record.prefixSha256 !== EMPTY_PAYLOAD_SHA256)) ||
    ((record.generation as number) > 0 &&
      (record.acknowledgedBytes as number) === 0)
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
      "Candidate payload checkpoint belongs to another owner, inode, generation, or byte boundary",
    );
  }
  return OBJECT_FREEZE({
    ...expected,
    generation: record.generation as number,
    acknowledgedBytes: record.acknowledgedBytes as number,
    prefixSha256: record.prefixSha256,
  });
}

function sameCheckpoint(
  left: Readonly<PayloadCheckpointJournal>,
  right: Readonly<PayloadCheckpointJournal>,
): boolean {
  return (
    left.version === right.version &&
    left.name === right.name &&
    left.ownerTokenSha256 === right.ownerTokenSha256 &&
    left.maximumBytes === right.maximumBytes &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.generation === right.generation &&
    left.acknowledgedBytes === right.acknowledgedBytes &&
    left.prefixSha256 === right.prefixSha256
  );
}

function payloadCheckpoint(
  identity: Readonly<PayloadIdentityJournal>,
  generation: number,
  acknowledgedBytes: number,
  prefixSha256: string,
): Readonly<PayloadCheckpointJournal> {
  return OBJECT_FREEZE({
    ...identity,
    generation,
    acknowledgedBytes,
    prefixSha256,
  });
}

function parseIdentityJournal(
  value: unknown,
  expected: PayloadOwnerJournal,
): Readonly<PayloadIdentityJournal> {
  if (
    !value ||
    typeof value !== "object" ||
    ARRAY_IS_ARRAY(value) ||
    OBJECT_GET_PROTOTYPE_OF(value) !== OBJECT_PROTOTYPE
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
      "Candidate payload identity journal is not canonical",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = sortedObjectKeys(record);
  if (
    !hasExactKeys(keys, [
      "device",
      "inode",
      "maximumBytes",
      "name",
      "ownerTokenSha256",
      "version",
    ]) ||
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
  return OBJECT_FREEZE({
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
    ARRAY_IS_ARRAY(value) ||
    OBJECT_GET_PROTOTYPE_OF(value) !== OBJECT_PROTOTYPE
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_OWNER_CONFLICT",
      "Candidate payload owner journal is not canonical",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = sortedObjectKeys(record);
  if (
    !hasExactKeys(keys, [
      "maximumBytes",
      "name",
      "ownerTokenSha256",
      "version",
    ]) ||
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
  return OBJECT_FREEZE({ ...expected });
}

function parseReceiptJournal(
  value: unknown,
  expected: PayloadOwnerJournal,
): Readonly<PayloadReceiptJournal> {
  if (
    !value ||
    typeof value !== "object" ||
    ARRAY_IS_ARRAY(value) ||
    OBJECT_GET_PROTOTYPE_OF(value) !== OBJECT_PROTOTYPE
  ) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
      "Candidate payload receipt journal is not canonical",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = sortedObjectKeys(record);
  if (
    !hasExactKeys(keys, [
      "maximumBytes",
      "name",
      "ownerTokenSha256",
      "receipt",
      "version",
    ]) ||
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
  return OBJECT_FREEZE({ ...expected, receipt });
}

async function readPayloadCheckpoints(
  authority: AgentBackupRestoreV3CandidateFsControl,
  names: readonly [string, string],
  identity: Readonly<PayloadIdentityJournal>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<
  readonly [
    Readonly<PayloadCheckpointJournal> | null,
    Readonly<PayloadCheckpointJournal> | null,
  ]
> {
  const checkpoints: Array<Readonly<PayloadCheckpointJournal> | null> = [];
  for (let slot = 0; slot < names.length; slot += 1) {
    const value = await readCandidateFsCanonicalJson(
      authority,
      names[slot] as string,
      4_096,
      control,
    );
    checkpoints.push(
      value === null ? null : parseCheckpointJournal(value, identity, slot),
    );
  }
  return OBJECT_FREEZE([
    checkpoints[0] ?? null,
    checkpoints[1] ?? null,
  ]) as readonly [
    Readonly<PayloadCheckpointJournal> | null,
    Readonly<PayloadCheckpointJournal> | null,
  ];
}

function selectPayloadCheckpoint(
  checkpoints: readonly [
    Readonly<PayloadCheckpointJournal> | null,
    Readonly<PayloadCheckpointJournal> | null,
  ],
): {
  readonly current: Readonly<PayloadCheckpointJournal> | null;
  readonly previous: Readonly<PayloadCheckpointJournal> | null;
  readonly ordered: readonly Readonly<PayloadCheckpointJournal>[];
} {
  const ordered: Readonly<PayloadCheckpointJournal>[] = [];
  if (checkpoints[0]) ordered[ordered.length] = checkpoints[0];
  if (checkpoints[1]) ordered[ordered.length] = checkpoints[1];
  REFLECT_APPLY(ARRAY_SORT, ordered, [
    (
      left: Readonly<PayloadCheckpointJournal>,
      right: Readonly<PayloadCheckpointJournal>,
    ) => left.generation - right.generation,
  ]);
  if (ordered.length === 2) {
    const previous = ordered[0] as Readonly<PayloadCheckpointJournal>;
    const current = ordered[1] as Readonly<PayloadCheckpointJournal>;
    if (
      current.generation !== previous.generation + 1 ||
      current.acknowledgedBytes <= previous.acknowledgedBytes
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
        "Candidate payload checkpoints are not one adjacent, increasing generation pair",
      );
    }
    return OBJECT_FREEZE({
      current,
      previous,
      ordered: OBJECT_FREEZE(ordered),
    });
  }
  const current = ordered[0] ?? null;
  return OBJECT_FREEZE({
    current,
    previous: null,
    ordered: OBJECT_FREEZE(ordered),
  });
}

async function hashAndValidatePayloadPrefix(
  handle: FileHandle,
  filePath: string,
  expectedIdentity: CandidateFsExactStats,
  checkpoints: readonly Readonly<PayloadCheckpointJournal>[],
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<{
  readonly hash: Hash;
  readonly stats: CandidateFsExactStats;
}> {
  const before = await assertBoundFile(
    handle,
    filePath,
    expectedIdentity,
    control,
  );
  const maximumAcknowledgedBytes =
    checkpoints[checkpoints.length - 1]?.acknowledgedBytes ?? 0;
  if (before.size < maximumAcknowledgedBytes) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
      "Candidate payload is shorter than its durable checkpoint",
    );
  }
  const hash = createSha256Hash();
  const chunk = new INTRINSIC_UINT8_ARRAY(
    Math.min(
      CANDIDATE_FS_IO_CHUNK_BYTES,
      Math.max(1, maximumAcknowledgedBytes),
    ),
  );
  const ioChunk = candidateFsNativeIoView(chunk);
  let position = 0;
  let checkpointIndex = 0;
  const validateReachedCheckpoints = () => {
    while (
      checkpointIndex < checkpoints.length &&
      (checkpoints[checkpointIndex] as PayloadCheckpointJournal)
        .acknowledgedBytes === position
    ) {
      const checkpoint = checkpoints[
        checkpointIndex
      ] as PayloadCheckpointJournal;
      if (hashDigestHex(copyHash(hash)) !== checkpoint.prefixSha256) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
          "Candidate payload prefix differs from its durable checkpoint",
        );
      }
      checkpointIndex += 1;
    }
  };
  try {
    validateReachedCheckpoints();
    while (position < maximumAcknowledgedBytes) {
      const nextBoundary =
        checkpoints[checkpointIndex]?.acknowledgedBytes ??
        maximumAcknowledgedBytes;
      const requested = Math.min(
        typedArrayByteLength(chunk),
        maximumAcknowledgedBytes - position,
        nextBoundary - position,
      );
      const read = await controlled(
        () => handle.read(ioChunk, 0, requested, position),
        control,
      );
      if (read.bytesRead <= 0) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
          "Candidate payload ended before its durable checkpoint",
        );
      }
      updateHash(hash, candidateFsByteView(chunk, 0, read.bytesRead));
      zeroBytes(chunk, 0, read.bytesRead);
      position += read.bytesRead;
      validateReachedCheckpoints();
    }
  } finally {
    zeroBytes(chunk);
  }
  if (checkpointIndex !== checkpoints.length) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
      "Candidate payload checkpoints are not ordered byte boundaries",
    );
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
      "Candidate payload changed while its checkpoint prefix was validated",
    );
  }
  return OBJECT_FREEZE({ hash, stats: after });
}

async function truncatePayloadToCheckpoint(
  handle: FileHandle,
  filePath: string,
  expectedIdentity: CandidateFsExactStats,
  acknowledgedBytes: number,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<CandidateFsExactStats> {
  assertActive(control);
  let truncated: CandidateFsExactStats | null = null;
  await boundedInternalCleanup(async () => {
    // Once truncation starts it must settle through fsync while the caller's
    // lock use is still held, even if its external control expires meanwhile.
    const failures: unknown[] = [];
    try {
      await handle.truncate(acknowledgedBytes);
    } catch (cause) {
      failures.push(cause);
    }
    try {
      await handle.sync();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      truncated = await assertBoundFile(
        handle,
        filePath,
        expectedIdentity,
        internalCleanupControl(),
      );
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures);
  });
  assertActive(control);
  const exactTruncated = truncated as CandidateFsExactStats | null;
  if (!exactTruncated) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_ROLLBACK_FAILED",
      "Candidate payload truncation ended without exact file state",
    );
  }
  if (exactTruncated.size !== acknowledgedBytes) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_ROLLBACK_FAILED",
      "Candidate payload did not truncate to its durable checkpoint",
    );
  }
  return exactTruncated;
}

async function reconcilePayloadCheckpointPublication(
  authority: AgentBackupRestoreV3CandidateFsControl,
  name: string,
  slot: number,
  expected: Readonly<PayloadCheckpointJournal>,
): Promise<"absent" | "exact"> {
  const cleanupControl = internalCleanupControl();
  let value: unknown | null;
  try {
    value = await readCandidateFsCanonicalJson(
      authority,
      name,
      4_096,
      cleanupControl,
    );
  } catch (cause) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_COMMIT_AMBIGUOUS",
      "Candidate payload checkpoint publication could not be reconciled",
      { cause },
    );
  }
  if (value === null) return "absent";
  let checkpoint: Readonly<PayloadCheckpointJournal>;
  try {
    checkpoint = parseCheckpointJournal(value, expected, slot);
  } catch (cause) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_COMMIT_AMBIGUOUS",
      "Candidate payload checkpoint publication resolved to an unreadable or conflicting value",
      { cause },
    );
  }
  if (!sameCheckpoint(checkpoint, expected)) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_COMMIT_AMBIGUOUS",
      "Candidate payload checkpoint publication resolved to another value",
    );
  }
  return "exact";
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
  const hash = createSha256Hash();
  const chunk = new INTRINSIC_UINT8_ARRAY(
    Math.min(CANDIDATE_FS_IO_CHUNK_BYTES, Math.max(1, before.size)),
  );
  const ioChunk = candidateFsNativeIoView(chunk);
  let position = 0;
  try {
    while (position < before.size) {
      const requested = Math.min(
        typedArrayByteLength(chunk),
        before.size - position,
      );
      const read = await controlled(
        () => handle.read(ioChunk, 0, requested, position),
        control,
      );
      if (read.bytesRead <= 0) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_TRUNCATED",
          "Candidate payload ended before its bound descriptor size",
        );
      }
      updateHash(hash, candidateFsByteView(chunk, 0, read.bytesRead));
      zeroBytes(chunk, 0, read.bytesRead);
      position += read.bytesRead;
    }
  } finally {
    zeroBytes(chunk);
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
  return OBJECT_FREEZE({
    ...candidateFsIdentity(after),
    sizeBytes: after.size,
    sha256: hashDigestHex(hash),
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
  #identityJournal: PayloadIdentityJournal | null;
  #receiptJournalName: string;
  #checkpointNames: readonly [string, string];
  #currentCheckpoint: Readonly<PayloadCheckpointJournal> | null;
  #previousCheckpoint: Readonly<PayloadCheckpointJournal> | null;
  #prefixHash: Hash | null;
  #stableStats: CandidateFsExactStats | null;
  #lock: AgentBackupRestoreV3CandidateFsLock;
  #ownsLock: boolean;
  #replayedReceipt: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt> | null;
  #writing = false;
  #closed = false;
  #finalizePromise: Promise<
    Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>
  > | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(input: {
    owner: AgentBackupRestoreV3CandidateFsControl;
    name: string;
    path: string;
    handle: FileHandle | null;
    identity: CandidateFsExactStats | null;
    maximumBytes: number;
    position: number;
    ownerJournal: PayloadOwnerJournal;
    identityJournal: PayloadIdentityJournal | null;
    receiptJournalName: string;
    checkpointNames: readonly [string, string];
    currentCheckpoint: Readonly<PayloadCheckpointJournal> | null;
    previousCheckpoint: Readonly<PayloadCheckpointJournal> | null;
    prefixHash: Hash | null;
    stableStats: CandidateFsExactStats | null;
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
    this.#identityJournal = input.identityJournal;
    this.#receiptJournalName = input.receiptJournalName;
    this.#checkpointNames = input.checkpointNames;
    this.#currentCheckpoint = input.currentCheckpoint;
    this.#previousCheckpoint = input.previousCheckpoint;
    this.#prefixHash = input.prefixHash;
    this.#stableStats = input.stableStats;
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
    const exactControl = snapshotOperationControl(control);
    const byteLength = payloadFragmentByteLength(fragment);
    if (byteLength === 0) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FRAGMENT_INVALID",
        "Candidate payload requires one non-empty byte fragment",
      );
    }
    if (byteLength > CANDIDATE_FS_IO_CHUNK_BYTES) {
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
      !this.#identityJournal ||
      !this.#currentCheckpoint ||
      !this.#prefixHash ||
      !this.#stableStats ||
      this.#replayedReceipt
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_STATE_INVALID",
        "Candidate payload writer is closed or already writing",
      );
    }
    if (this.#position > this.#maximumBytes - byteLength) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_LIMIT",
        "Candidate payload exceeds its explicit byte bound",
      );
    }
    const owned = copyPayloadFragment(fragment, byteLength);
    let releaseLockUse: () => void;
    try {
      releaseLockUse = this.#owner.beginLockUse(this.#lock);
    } catch (cause) {
      zeroBytes(owned);
      throw cause;
    }
    const durablePosition = this.#position;
    let writeStarted = false;
    let checkpointCommitted = false;
    let rollbackPermitted = true;
    let lockUseReleased = false;
    this.#writing = true;
    return (async () => {
      let nextHash: Hash | null = null;
      try {
        await this.#owner.assertLockHeld(this.#lock, exactControl);
        const before = await assertBoundFile(
          this.#handle as FileHandle,
          this.#path,
          this.#identity as CandidateFsExactStats,
          exactControl,
        );
        if (
          !sameStableFile(before, this.#stableStats as CandidateFsExactStats) ||
          before.size !== durablePosition
        ) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
            "Candidate payload changed after its last durable checkpoint",
          );
        }
        await this.#owner.assertLockHeld(this.#lock, exactControl);

        const currentCheckpoint = this
          .#currentCheckpoint as Readonly<PayloadCheckpointJournal>;
        if (currentCheckpoint.generation === Number.MAX_SAFE_INTEGER) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_LIMIT",
            "Candidate payload checkpoint generation is exhausted",
          );
        }
        const nextGeneration = currentCheckpoint.generation + 1;
        const targetSlot = nextGeneration % 2;
        const targetName = this.#checkpointNames[targetSlot] as string;
        const visibleTarget = await readCandidateFsCanonicalJson(
          this.#owner,
          targetName,
          4_096,
          exactControl,
        );
        if (visibleTarget === null) {
          if (this.#previousCheckpoint !== null) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
              "Candidate payload stale checkpoint disappeared before replacement",
            );
          }
        } else {
          const stale = parseCheckpointJournal(
            visibleTarget,
            this.#identityJournal as PayloadIdentityJournal,
            targetSlot,
          );
          if (
            this.#previousCheckpoint === null ||
            !sameCheckpoint(stale, this.#previousCheckpoint)
          ) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
              "Candidate payload replacement target is not its exact stale checkpoint",
            );
          }
          assertActive(exactControl);
          await fs.unlink(
            this.#owner.directPath(targetName, "payload checkpoint name"),
          );
        }
        // Establish durable absence before extending the payload. A crash can
        // therefore expose either the old checkpoint or the new one, never an
        // overwritten value with uncertain provenance.
        await this.#owner.syncAttemptRoot(exactControl);

        nextHash = copyHash(this.#prefixHash as Hash);
        updateHash(nextHash, owned);
        const nextAcknowledgedBytes = durablePosition + byteLength;
        const nextCheckpoint = payloadCheckpoint(
          this.#identityJournal as PayloadIdentityJournal,
          nextGeneration,
          nextAcknowledgedBytes,
          hashDigestHex(copyHash(nextHash)),
        );
        writeStarted = true;
        await writeAll(
          this.#handle as FileHandle,
          owned,
          durablePosition,
          exactControl,
        );
        // acknowledgedBytes is a crash-resume boundary: do not expose the
        // new offset until both payload data and its file size are durable.
        await controlled(
          () => (this.#handle as FileHandle).sync(),
          exactControl,
        );
        const afterWrite = await assertBoundFile(
          this.#handle as FileHandle,
          this.#path,
          this.#identity as CandidateFsExactStats,
          exactControl,
        );
        if (afterWrite.size !== nextAcknowledgedBytes) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
            "Candidate payload did not reach its next exact checkpoint boundary",
          );
        }
        await this.#owner.assertLockHeld(this.#lock, exactControl);

        try {
          await publishCandidateFsDurableJson(
            this.#owner,
            targetName,
            nextCheckpoint,
            { maximumBytes: 4_096 },
            exactControl,
            this.#lock,
          );
          checkpointCommitted = true;
        } catch (publicationCause) {
          // From the link syscall onward a rejected publication may still be
          // durable. Reconcile under the bounded internal control before any
          // destructive rollback decision.
          rollbackPermitted = false;
          let publicationState: "absent" | "exact";
          try {
            publicationState = await reconcilePayloadCheckpointPublication(
              this.#owner,
              targetName,
              targetSlot,
              nextCheckpoint,
            );
          } catch (reconciliationCause) {
            throw new AgentBackupRestoreV3CandidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_COMMIT_AMBIGUOUS",
              "Candidate payload checkpoint publication has an ambiguous durable outcome",
              {
                cause: new AggregateError([
                  publicationCause,
                  reconciliationCause,
                ]),
              },
            );
          }
          if (publicationState === "exact") {
            checkpointCommitted = true;
          } else {
            rollbackPermitted = true;
          }
          if (!checkpointCommitted) throw publicationCause;

          this.#previousCheckpoint = currentCheckpoint;
          this.#currentCheckpoint = nextCheckpoint;
          this.#position = nextAcknowledgedBytes;
          this.#prefixHash = nextHash;
          nextHash = null;
          this.#stableStats = await assertBoundFile(
            this.#handle as FileHandle,
            this.#path,
            this.#identity as CandidateFsExactStats,
            internalCleanupControl(),
          );
          throw publicationCause;
        }

        // The durable checkpoint is the commit point. Only now advance the
        // writer's in-memory resume boundary and incremental hash state.
        this.#previousCheckpoint = currentCheckpoint;
        this.#currentCheckpoint = nextCheckpoint;
        this.#position = nextAcknowledgedBytes;
        this.#prefixHash = nextHash;
        nextHash = null;
        const afterCheckpoint = await assertBoundFile(
          this.#handle as FileHandle,
          this.#path,
          this.#identity as CandidateFsExactStats,
          exactControl,
        );
        if (
          afterCheckpoint.size !== nextAcknowledgedBytes ||
          !sameStableFile(afterWrite, afterCheckpoint)
        ) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
            "Candidate payload changed while its durable checkpoint was published",
          );
        }
        this.#stableStats = afterCheckpoint;
        await this.#owner.assertLockHeld(this.#lock, exactControl);
      } catch (cause) {
        this.#closed = true;
        const failures: unknown[] = [cause];
        if (
          writeStarted &&
          !checkpointCommitted &&
          rollbackPermitted &&
          this.#handle &&
          this.#identity
        ) {
          try {
            const cleanupControl = internalCleanupControl();
            this.#stableStats = await truncatePayloadToCheckpoint(
              this.#handle as FileHandle,
              this.#path,
              this.#identity as CandidateFsExactStats,
              durablePosition,
              cleanupControl,
            );
          } catch (rollbackCause) {
            failures.push(rollbackCause);
          }
        }
        releaseLockUse();
        lockUseReleased = true;
        try {
          await this.#disposeResources();
        } catch (cleanupCause) {
          failures.push(cleanupCause);
        }
        if (failures.length > 1) {
          throw new AgentBackupRestoreV3CandidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_CLEANUP_FAILED",
            "Candidate payload write failed and rollback or resource cleanup also failed",
            { cause: new AggregateError(failures) },
          );
        }
        throw cause;
      } finally {
        if (!lockUseReleased) releaseLockUse();
        zeroBytes(owned);
        nextHash = null;
        this.#writing = false;
      }
    })();
  }

  finalize(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>> {
    if (this.#finalizePromise) return this.#finalizePromise;
    if (this.#closed || this.#writing) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_STATE_INVALID",
        "Candidate payload writer cannot finalize in its current state",
      );
    }
    const exactControl = snapshotOperationControl(control);
    const releaseLockUse = this.#owner.beginLockUse(this.#lock);
    this.#closed = true;
    this.#finalizePromise = this.#finalizeOnce(exactControl, releaseLockUse);
    return this.#finalizePromise;
  }

  async #finalizeOnce(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    releaseLockUse: () => void,
  ): Promise<Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>> {
    let primaryFailure: unknown;
    let primaryFailed = false;
    let result: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt> | null =
      null;
    try {
      await this.#owner.assertLockHeld(this.#lock, control);
      if (this.#replayedReceipt) {
        result = this.#replayedReceipt;
      } else {
        if (
          !this.#handle ||
          !this.#identity ||
          !this.#currentCheckpoint ||
          !this.#prefixHash ||
          !this.#stableStats
        ) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_STATE_INVALID",
            "Candidate payload writer lost its bound descriptor or checkpoint state",
          );
        }
        await controlled(() => (this.#handle as FileHandle).sync(), control);
        const before = await assertBoundFile(
          this.#handle as FileHandle,
          this.#path,
          this.#identity as CandidateFsExactStats,
          control,
        );
        if (
          before.size !== this.#position ||
          !sameStableFile(before, this.#stableStats as CandidateFsExactStats) ||
          this.#currentCheckpoint.acknowledgedBytes !== this.#position
        ) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
            "Candidate payload differs from this writer's durable checkpoint",
          );
        }
        const receipt = OBJECT_FREEZE({
          ...candidateFsIdentity(before),
          sizeBytes: before.size,
          sha256: hashDigestHex(copyHash(this.#prefixHash)),
        });
        if (receipt.sha256 !== this.#currentCheckpoint.prefixSha256) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
            "Candidate payload hash state differs from its durable checkpoint",
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
        const after = await assertBoundFile(
          this.#handle as FileHandle,
          this.#path,
          this.#identity as CandidateFsExactStats,
          control,
        );
        if (!sameStableFile(before, after)) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_CHANGED",
            "Candidate payload changed while its receipt was published",
          );
        }
        result = receipt;
      }
    } catch (cause) {
      primaryFailed = true;
      primaryFailure = cause;
    }
    releaseLockUse();
    try {
      await this.#disposeResources();
    } catch (cleanupCause) {
      if (primaryFailed) {
        throw new AgentBackupRestoreV3CandidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_CLEANUP_FAILED",
          "Candidate payload finalization and resource cleanup both failed",
          { cause: new AggregateError([primaryFailure, cleanupCause]) },
        );
      }
      throw cleanupCause;
    }
    if (primaryFailed) throw primaryFailure;
    if (!result) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_STATE_INVALID",
        "Candidate payload finalization ended without an exact receipt",
      );
    }
    return result;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#finalizePromise) {
      this.#closePromise = this.#finalizePromise.then(() => undefined);
      return this.#closePromise;
    }
    if (this.#writing) {
      try {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_STATE_INVALID",
          "Candidate payload writer cannot close during a write",
        );
      } catch (cause) {
        return Promise.reject(cause);
      }
    }
    if (this.#closed) {
      this.#closePromise = Promise.resolve();
      return this.#closePromise;
    }
    this.#closed = true;
    this.#closePromise = this.#disposeResources();
    return this.#closePromise;
  }

  async #disposeResources(): Promise<void> {
    let firstFailure: unknown;
    let firstFailed = false;
    const handle = this.#handle;
    this.#handle = null;
    if (handle) {
      try {
        await boundedInternalCleanup(() => handle.close());
      } catch (cause) {
        firstFailed = true;
        firstFailure = cause;
      }
    }
    const lock = this.#lock;
    if (this.#ownsLock) {
      this.#ownsLock = false;
      try {
        await lock.release(internalCleanupControl());
      } catch (cause) {
        if (firstFailed) {
          throw new AggregateError([firstFailure, cause]);
        }
        throw cause;
      }
    }
    if (firstFailed) throw firstFailure;
  }
}

export async function createCandidateFsPayload(
  authority: AgentBackupRestoreV3CandidateFsControl,
  name: string,
  options: Readonly<CreateAgentBackupRestoreV3CandidatePayloadOptions>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<AgentBackupRestoreV3CandidatePayloadWriter> {
  const payloadOptions = snapshotOwnDataRecord(
    options,
    ["maximumBytes", "ownerToken"],
    ["maximumBytes", "ownerToken"],
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LIMIT_INVALID",
    "Candidate payload creation options must be exact data properties",
  );
  const maximumBytes = requirePositiveSafeInteger(
    payloadOptions.maximumBytes as number,
    "maximumBytes",
  );
  const ownerSha256 = ownerTokenSha256(payloadOptions.ownerToken as Uint8Array);
  const ownerJournal: PayloadOwnerJournal = OBJECT_FREEZE({
    version: 1,
    name: requireControlName(name, "payload name"),
    ownerTokenSha256: ownerSha256,
    maximumBytes,
  });
  const journalNames = payloadJournalNames(name);
  const payloadPath = authority.directPath(name, "payload name");
  await authority.assertAuthority(control);
  const operationLock = await authority.operationLock(
    `.payload-${stringSlice(ownerSha256, 0, 16)}`,
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
  let releaseLockUse: (() => void) | null = null;
  try {
    releaseLockUse = authority.beginLockUse(activeLock);
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
      const replayWriter = new AgentBackupRestoreV3CandidatePayloadWriter({
        owner: authority,
        name,
        path: payloadPath,
        handle: null,
        identity: null,
        maximumBytes,
        position: proved.sizeBytes,
        ownerJournal,
        identityJournal,
        receiptJournalName: journalNames.receipt,
        checkpointNames: journalNames.checkpoints,
        currentCheckpoint: null,
        previousCheckpoint: null,
        prefixHash: null,
        stableStats: null,
        lock: activeLock,
        ownsLock: operationLock !== null,
        replayedReceipt: proved,
      });
      releaseLockUse();
      releaseLockUse = null;
      return replayWriter;
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
        const handleToClose = orphanHandle as FileHandle;
        await runAllBoundedInternalCleanup([
          async () => {
            await handleToClose.close();
            orphanHandle = null;
          },
          () =>
            syncDirectory(authority.attemptAuthority, internalCleanupControl()),
        ]);
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
    const durableIdentityJournal: Readonly<PayloadIdentityJournal> =
      identityJournal ??
      OBJECT_FREEZE({
        ...ownerJournal,
        ...candidateFsIdentity(opened),
      });
    if (!identityJournal) {
      await publishCandidateFsDurableJson(
        authority,
        journalNames.identity,
        durableIdentityJournal,
        { maximumBytes: 4_096 },
        control,
        activeLock,
      );
    }

    let checkpointPair = await readPayloadCheckpoints(
      authority,
      journalNames.checkpoints,
      durableIdentityJournal,
      control,
    );
    let selected = selectPayloadCheckpoint(checkpointPair);
    if (selected.current === null) {
      const initialCheckpoint = payloadCheckpoint(
        durableIdentityJournal,
        0,
        0,
        EMPTY_PAYLOAD_SHA256,
      );
      await publishCandidateFsDurableJson(
        authority,
        journalNames.checkpoints[0],
        initialCheckpoint,
        { maximumBytes: 4_096 },
        control,
        activeLock,
      );
      checkpointPair = OBJECT_FREEZE([initialCheckpoint, null]);
      selected = selectPayloadCheckpoint(checkpointPair);
    }
    const currentCheckpoint = selected.current;
    if (!currentCheckpoint) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
        "Candidate payload did not establish an initial durable checkpoint",
      );
    }
    let validatedPrefix = await hashAndValidatePayloadPrefix(
      handle as FileHandle,
      payloadPath,
      opened,
      selected.ordered,
      control,
    );
    let stableStats = validatedPrefix.stats;
    if (stableStats.size > currentCheckpoint.acknowledgedBytes) {
      stableStats = await truncatePayloadToCheckpoint(
        handle as FileHandle,
        payloadPath,
        opened,
        currentCheckpoint.acknowledgedBytes,
        control,
      );
      // Truncation is a mutation boundary. Re-hash the acknowledged prefix
      // afterwards so a concurrent same-inode rewrite during truncate cannot
      // pair stale hash state with the newly truncated file.
      validatedPrefix = await hashAndValidatePayloadPrefix(
        handle as FileHandle,
        payloadPath,
        opened,
        selected.ordered,
        control,
      );
      stableStats = validatedPrefix.stats;
    }
    await authority.assertLockHeld(activeLock, control);
    const writer = new AgentBackupRestoreV3CandidatePayloadWriter({
      owner: authority,
      name,
      path: payloadPath,
      handle: handle as FileHandle,
      identity: opened,
      maximumBytes,
      position: currentCheckpoint.acknowledgedBytes,
      ownerJournal,
      identityJournal: durableIdentityJournal,
      receiptJournalName: journalNames.receipt,
      checkpointNames: journalNames.checkpoints,
      currentCheckpoint,
      previousCheckpoint: selected.previous,
      prefixHash: validatedPrefix.hash,
      stableStats,
      lock: activeLock,
      ownsLock: operationLock !== null,
    });
    await authority.assertLockHeld(activeLock, control);
    handle = null;
    releaseLockUse();
    releaseLockUse = null;
    return writer;
  } catch (cause) {
    const cleanupOperations: Array<() => Promise<void>> = [];
    const handleToClose = handle;
    if (handleToClose) {
      handle = null;
      cleanupOperations.push(() => handleToClose.close());
    }
    if (releaseLockUse) {
      const releaseUse = releaseLockUse;
      releaseLockUse = null;
      cleanupOperations.push(async () => releaseUse());
    }
    if (operationLock) {
      cleanupOperations.push(() =>
        operationLock.release(internalCleanupControl()),
      );
    }
    try {
      await runAllBoundedInternalCleanup(cleanupOperations);
    } catch (cleanupCause) {
      throw new AgentBackupRestoreV3CandidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_WRITER_CLEANUP_FAILED",
        "Candidate payload setup and resource cleanup both failed",
        { cause: new AggregateError([cause, cleanupCause]) },
      );
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
  const expected = parsePayloadReceipt(expectedValue, Number.MAX_SAFE_INTEGER);
  const proofOptions = snapshotOwnDataRecord(
    options,
    ["maximumBytes"],
    ["maximumBytes"],
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LIMIT_INVALID",
    "Candidate payload proof options must be exact data properties",
  );
  const maximumBytes = requirePositiveSafeInteger(
    proofOptions.maximumBytes as number,
    "maximumBytes",
  );
  if (expected.sizeBytes > maximumBytes) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_RECEIPT_INVALID",
      "Candidate payload receipt exceeds its proof byte bound",
    );
  }
  await authority.assertAuthority(control);
  const operationLock = await authority.operationLock(
    `.prove-${stringSlice(sha256Hex(name), 0, 16)}`,
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
  let releaseLockUse: (() => void) | null = null;
  try {
    releaseLockUse = authority.beginLockUse(activeLock);
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
    releaseLockUse?.();
    if (operationLock) {
      await operationLock.release(internalCleanupControl());
    }
  }
}

/**
 * Reads one already-proved immutable payload from its exact descriptor while
 * the candidate inode lock is held for the entire bounded operation.
 */
export async function readCandidateFsPayload(
  authority: AgentBackupRestoreV3CandidateFsControl,
  name: string,
  expectedValue: Readonly<AgentBackupRestoreV3CandidatePayloadReceipt>,
  options: Readonly<ReadAgentBackupRestoreV3CandidatePayloadOptions>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidatePayloadRead>> {
  const readOptions = snapshotOwnDataRecord(
    options,
    ["maximumBytes", "ownerToken"],
    ["maximumBytes", "ownerToken"],
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LIMIT_INVALID",
    "Candidate payload read options must be exact data properties",
  );
  const maximumBytes = requirePositiveSafeInteger(
    readOptions.maximumBytes as number,
    "maximumBytes",
  );
  if (maximumBytes > CANDIDATE_FS_IO_CHUNK_BYTES) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_READ_LIMIT",
      "Candidate atomic payload read exceeds 256 KiB",
    );
  }
  const expected = parsePayloadReceipt(expectedValue, maximumBytes);
  const exactName = requireControlName(name, "payload name");
  const ownerJournal: PayloadOwnerJournal = OBJECT_FREEZE({
    version: 1,
    name: exactName,
    ownerTokenSha256: ownerTokenSha256(readOptions.ownerToken as Uint8Array),
    maximumBytes,
  });
  const journalNames = payloadJournalNames(exactName);
  const payloadPath = authority.directPath(exactName, "payload name");
  await authority.assertAuthority(control);
  const operationLock = await authority.operationLock(
    `.read-payload-${stringSlice(sha256Hex(exactName), 0, 16)}`,
    control,
    heldLock,
  );
  const activeLock = operationLock ?? heldLock;
  if (!activeLock) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
      "Candidate payload read did not obtain an exact inode-lock lease",
    );
  }
  let handle: FileHandle | null = null;
  let releaseLockUse: (() => void) | null = null;
  let payload: Uint8Array | null = null;
  let result: Readonly<AgentBackupRestoreV3CandidatePayloadRead> | null = null;
  let primaryFailure: unknown;
  let primaryFailed = false;
  try {
    releaseLockUse = authority.beginLockUse(activeLock);
    await authority.assertLockHeld(activeLock, control);
    const persistedOwner = await readCandidateFsCanonicalJsonReadOnly(
      authority,
      journalNames.owner,
      4_096,
      control,
    );
    const persistedIdentity = await readCandidateFsCanonicalJsonReadOnly(
      authority,
      journalNames.identity,
      4_096,
      control,
    );
    const persistedReceipt = await readCandidateFsCanonicalJsonReadOnly(
      authority,
      journalNames.receipt,
      4_096,
      control,
    );
    if (
      persistedOwner === null ||
      persistedIdentity === null ||
      persistedReceipt === null
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
        "Candidate proved payload lacks its complete immutable owner journals",
      );
    }
    parseOwnerJournal(persistedOwner, ownerJournal);
    const identityJournal = parseIdentityJournal(
      persistedIdentity,
      ownerJournal,
    );
    const receiptJournal = parseReceiptJournal(persistedReceipt, ownerJournal);
    if (
      receiptJournal.receipt.sizeBytes !== expected.sizeBytes ||
      receiptJournal.receipt.sha256 !== expected.sha256 ||
      receiptJournal.receipt.device !== expected.device ||
      receiptJournal.receipt.inode !== expected.inode ||
      identityJournal.device !== expected.device ||
      identityJournal.inode !== expected.inode
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
        "Candidate payload owner journals differ from its exact read receipt",
      );
    }
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
          "Candidate proved payload is absent",
        );
      }
      throw cause;
    }
    const opened = await controlled(
      () => fileStatExact(handle as FileHandle),
      control,
    );
    requirePrivateSingleLinkFile(
      opened,
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_FILE_UNSAFE",
      "Candidate payload read is not one private regular file",
    );
    if (
      opened.size !== expected.sizeBytes ||
      opened.device.toString(10) !== expected.device ||
      opened.inode.toString(10) !== expected.inode
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
        "Candidate payload identity differs from its exact receipt",
      );
    }
    const before = await assertBoundFile(
      handle as FileHandle,
      payloadPath,
      opened,
      control,
    );
    const exactPayload = new INTRINSIC_UINT8_ARRAY(before.size);
    const ioPayload = candidateFsNativeIoView(exactPayload);
    const exactPayloadByteLength = typedArrayByteLength(exactPayload);
    payload = exactPayload;
    let offset = 0;
    const hash = createSha256Hash();
    while (offset < exactPayloadByteLength) {
      const read = await controlled(
        () =>
          (handle as FileHandle).read(
            ioPayload,
            offset,
            exactPayloadByteLength - offset,
            offset,
          ),
        control,
      );
      if (read.bytesRead <= 0) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_TRUNCATED",
          "Candidate payload ended before its exact receipt size",
        );
      }
      updateHash(
        hash,
        candidateFsByteView(exactPayload, offset, offset + read.bytesRead),
      );
      offset += read.bytesRead;
    }
    const after = await assertBoundFile(
      handle as FileHandle,
      payloadPath,
      opened,
      control,
    );
    if (
      !sameStableFile(before, after) ||
      hashDigestHex(hash) !== expected.sha256
    ) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_CONFLICT",
        "Candidate payload bytes differ from their exact receipt",
      );
    }
    await authority.assertLockHeld(activeLock, control);
    result = OBJECT_FREEZE({ receipt: expected, payload: exactPayload });
  } catch (cause) {
    primaryFailed = true;
    primaryFailure = cause;
  }

  const cleanupFailures: unknown[] = [];
  if (handle) {
    try {
      await boundedInternalCleanup(() => (handle as FileHandle).close());
      handle = null;
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  if (releaseLockUse) {
    try {
      releaseLockUse();
      releaseLockUse = null;
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  if (operationLock) {
    try {
      await operationLock.release(internalCleanupControl());
    } catch (cause) {
      cleanupFailures.push(cause);
    }
  }
  if (primaryFailed || cleanupFailures.length > 0 || !result) {
    if (payload) zeroBytes(payload);
    if (primaryFailed && cleanupFailures.length > 0) {
      throw new AgentBackupRestoreV3CandidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_READ_FAILED",
        "Candidate payload read and bounded cleanup both failed",
        {
          cause: new AggregateError([primaryFailure, ...cleanupFailures]),
          severity: "fatal",
        },
      );
    }
    if (primaryFailed) throw primaryFailure;
    if (cleanupFailures.length === 1) throw cleanupFailures[0];
    if (cleanupFailures.length > 1) throw new AggregateError(cleanupFailures);
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_PAYLOAD_READ_FAILED",
      "Candidate payload read ended without an exact result",
    );
  }
  payload = null;
  return result;
}
