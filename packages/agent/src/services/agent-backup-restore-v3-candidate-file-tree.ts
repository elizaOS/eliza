/**
 * Exact no-follow file-tree materialization below one isolated candidate.
 *
 * Every published file is written through a descriptor-bound private partial,
 * fsynced, metadata-bound, then linked without replacement. The deterministic
 * partial makes a pre-publication crash recoverable while an exact final file
 * makes response-loss replay read-only.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  type AgentBackupRestoreV3OperationControl,
  compareAgentBackupCaptureV2FilePaths,
} from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateFsControl,
  AgentBackupRestoreV3CandidateFsError,
  type AgentBackupRestoreV3CandidateFsIdentity,
  type AgentBackupRestoreV3CandidateFsLock,
  assertActive,
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
  requirePathSegment,
  requirePositiveSafeInteger,
  requirePrivateDirectory,
  requireRelativePath,
  runAllBoundedInternalCleanup,
  sameIdentity,
  sameStableFile,
  snapshotOperationControl,
  snapshotOwnDataRecord,
  writeAll,
} from "./agent-backup-restore-v3-candidate-fs-control";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";

const FILE_TREE_DERIVATION =
  "elizaos.agent-backup.restore-v3-candidate-file-tree.v1";
const RESERVED_PREFIX = ".restore-v3-";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUFFER_DIRECTORY_ENCODING = "buffer" as BufferEncoding;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const TYPED_ARRAY_PROTOTYPE = OBJECT_GET_PROTOTYPE_OF(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)?.get;
const REFLECT_APPLY = Reflect.apply;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const ARRAY_SORT = Array.prototype.sort;
const BUFFER_FROM = Buffer.from;
const BUFFER_COMPARE = Buffer.compare;
const BUFFER_TO_STRING = Buffer.prototype.toString;
const IS_PROXY = utilTypes.isProxy;
const IS_UINT8_ARRAY = utilTypes.isUint8Array;
const OBJECT_IS = Object.is;
const MAXIMUM_DATE_EPOCH_MS = 8_640_000_000_000_000;
const CANDIDATE_FILE_STAGING_MODE = 0o600;
const CANDIDATE_FILE_CONTROL_MODE_MASK = 0o7777;
// Linux uapi O_PATH. Node/Bun do not expose it consistently in fs.constants.
const LINUX_O_PATH = 0o10000000;

function typedArrayByteLength(value: Uint8Array): number {
  return REFLECT_APPLY(
    TYPED_ARRAY_BYTE_LENGTH_GETTER as () => number,
    value,
    [],
  );
}

function typedArrayBuffer(value: Uint8Array): ArrayBufferLike {
  return REFLECT_APPLY(
    TYPED_ARRAY_BUFFER_GETTER as () => ArrayBufferLike,
    value,
    [],
  );
}

function typedArrayByteOffset(value: Uint8Array): number {
  return REFLECT_APPLY(
    TYPED_ARRAY_BYTE_OFFSET_GETTER as () => number,
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

function bufferFromString(value: string, encoding: BufferEncoding): Buffer {
  return REFLECT_APPLY(BUFFER_FROM, Buffer, [value, encoding]);
}

function bufferFromArrayBuffer(
  value: ArrayBufferLike,
  byteOffset: number,
  byteLength: number,
): Buffer {
  return REFLECT_APPLY(BUFFER_FROM, Buffer, [value, byteOffset, byteLength]);
}

function bufferCompare(left: Uint8Array, right: Uint8Array): number {
  return REFLECT_APPLY(BUFFER_COMPARE, Buffer, [left, right]);
}

function bufferToUtf8(value: Buffer): string {
  return REFLECT_APPLY(BUFFER_TO_STRING, value, ["utf8"]);
}

function pathUtf8Hex(value: string): string {
  const encoded = bufferFromString(value, "utf8");
  try {
    return REFLECT_APPLY(BUFFER_TO_STRING, encoded, ["hex"]);
  } finally {
    zeroBytes(encoded);
  }
}

function compareNames(left: string, right: string): number {
  const encodedLeft = bufferFromString(left, "utf8");
  const encodedRight = bufferFromString(right, "utf8");
  try {
    return bufferCompare(encodedLeft, encodedRight);
  } finally {
    zeroBytes(encodedLeft);
    zeroBytes(encodedRight);
  }
}

function sortNames(value: string[]): string[] {
  REFLECT_APPLY(ARRAY_SORT, value, [compareNames]);
  return value;
}

export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS = Object.freeze(
  {
    maximumBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes,
    maximumFiles: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFiles,
    maximumDirectories: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFiles,
    maximumDepth: 32,
    maximumPathBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPathBytes,
  },
);

export interface AgentBackupRestoreV3CandidateFileTreeLimits {
  readonly maximumBytes: number;
  readonly maximumFiles: number;
  readonly maximumDirectories: number;
  readonly maximumDepth: number;
  readonly maximumPathBytes: number;
}

export interface AgentBackupRestoreV3CandidateFileTreeFileSpec {
  readonly path: string;
  readonly sizeBytes: number;
  readonly mode: number;
  readonly mtimeMs: number;
}

export interface AgentBackupRestoreV3CandidateFileTreeFileProof
  extends AgentBackupRestoreV3CandidateFileTreeFileSpec,
    AgentBackupRestoreV3CandidateFsIdentity {
  readonly sha256: string;
}

export interface AgentBackupRestoreV3CandidateFileTreeProof
  extends AgentBackupRestoreV3CandidateFsIdentity {
  readonly derivation: typeof FILE_TREE_DERIVATION;
  readonly sha256: string;
  readonly bytes: number;
  readonly files: number;
  readonly directories: number;
  readonly entries: readonly Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>[];
}

interface StableFileTreeDirectory {
  readonly relativePath: string;
  readonly targetPath: string;
  readonly stats: CandidateFsExactStats;
}

function fileTreeError(code: string, message: string, cause?: unknown): never {
  candidateFsError(code, message, cause === undefined ? undefined : { cause });
}

function resolveLimits(
  value: Partial<AgentBackupRestoreV3CandidateFileTreeLimits> | undefined,
): Readonly<AgentBackupRestoreV3CandidateFileTreeLimits> {
  const snapshot: Readonly<Record<string, unknown>> =
    value === undefined
      ? OBJECT_FREEZE({})
      : snapshotOwnDataRecord(
          value,
          [
            "maximumBytes",
            "maximumFiles",
            "maximumDirectories",
            "maximumDepth",
            "maximumPathBytes",
          ],
          [],
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT_INVALID",
          "Candidate file-tree limits must be exact data properties",
        );
  const limits = OBJECT_FREEZE({
    maximumBytes: requirePositiveSafeInteger(
      (snapshot.maximumBytes as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS.maximumBytes,
      "maximumBytes",
    ),
    maximumFiles: requirePositiveSafeInteger(
      (snapshot.maximumFiles as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS.maximumFiles,
      "maximumFiles",
    ),
    maximumDirectories: requirePositiveSafeInteger(
      (snapshot.maximumDirectories as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS.maximumDirectories,
      "maximumDirectories",
    ),
    maximumDepth: requirePositiveSafeInteger(
      (snapshot.maximumDepth as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS.maximumDepth,
      "maximumDepth",
    ),
    maximumPathBytes: requirePositiveSafeInteger(
      (snapshot.maximumPathBytes as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS.maximumPathBytes,
      "maximumPathBytes",
    ),
  });
  if (
    limits.maximumBytes >
      AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS.maximumBytes ||
    limits.maximumFiles >
      AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS.maximumFiles ||
    limits.maximumDirectories >
      AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS.maximumDirectories ||
    limits.maximumDepth >
      AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS.maximumDepth ||
    limits.maximumPathBytes >
      AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMITS.maximumPathBytes
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT_INVALID",
      "Candidate file-tree limits cannot exceed the authenticated stream bounds",
    );
  }
  return limits;
}

function exactMtimeMs(stats: CandidateFsExactStats): number {
  if (stats.modifiedNanoseconds < 0n) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
      "Candidate file mtime is outside the exact stream range",
    );
  }
  // Capture v2 stores Math.trunc(Stats.mtimeMs). Reconstruct the same
  // seconds-plus-nanoseconds projection instead of dividing the full bigint:
  // libuv's double-second futimes representation can land a few nanoseconds
  // either side of the requested millisecond on Linux while Stats.mtimeMs
  // still round-trips to the exact captured integer.
  const wholeSeconds = stats.modifiedNanoseconds / 1_000_000_000n;
  const remainingNanoseconds = stats.modifiedNanoseconds % 1_000_000_000n;
  const value = Math.trunc(
    Number(wholeSeconds) * 1_000 + Number(remainingNanoseconds) / 1_000_000,
  );
  if (!Number.isSafeInteger(value) || value < 0) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
      "Candidate file mtime is outside the exact stream range",
    );
  }
  return value;
}

async function applyExactMtimeMs(
  handle: FileHandle,
  mtimeMs: number,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<void> {
  const exactTime = new Date(mtimeMs);
  await controlled(() => handle.utimes(exactTime, exactTime), control);
  const firstObserved = await controlled(() => fileStatExact(handle), control);
  let deltaMs = mtimeMs - exactMtimeMs(firstObserved);
  if (deltaMs === 0) return;

  let seconds = mtimeMs / 1_000;
  let previousDeltaMagnitude = Math.abs(deltaMs);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const previousSeconds = seconds;
    seconds += deltaMs / 1_000;
    if (!Number.isFinite(seconds)) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
        "Candidate file mtime correction could not converge exactly",
      );
    }
    await controlled(() => handle.utimes(seconds, seconds), control);
    const observed = await controlled(() => fileStatExact(handle), control);
    deltaMs = mtimeMs - exactMtimeMs(observed);
    if (deltaMs === 0) return;
    const deltaMagnitude = Math.abs(deltaMs);
    if (
      seconds === previousSeconds ||
      deltaMagnitude >= previousDeltaMagnitude
    ) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
        "Candidate file mtime correction did not make exact progress",
      );
    }
    previousDeltaMagnitude = deltaMagnitude;
  }
  fileTreeError(
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
    "Candidate file mtime did not converge to its exact nanosecond target",
  );
}

function requireRegularSingleLink(
  stats: CandidateFsExactStats,
  message: string,
): void {
  if (!stats.file || stats.symbolicLink || stats.linkCount !== 1) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_UNSAFE",
      message,
    );
  }
}

function requireCanonicalFilePath(
  value: string,
  limits: Readonly<AgentBackupRestoreV3CandidateFileTreeLimits>,
): readonly string[] {
  const platformPath = requireRelativePath(value, "candidate file path");
  const encoded = new TextEncoder().encode(value);
  if (
    encoded.byteLength > limits.maximumPathBytes ||
    new TextDecoder("utf-8", { fatal: true }).decode(encoded) !== value
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_PATH_FORBIDDEN",
      "Candidate file path is not bounded canonical UTF-8",
    );
  }
  const segments = platformPath.split(path.sep);
  if (
    segments.length > limits.maximumDepth ||
    segments.some((segment) =>
      segment.toLowerCase().startsWith(RESERVED_PREFIX),
    )
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_PATH_FORBIDDEN",
      "Candidate file path is too deep or uses a reserved control name",
    );
  }
  return Object.freeze(segments);
}

function parseFileSpec(
  value: Readonly<AgentBackupRestoreV3CandidateFileTreeFileSpec>,
  limits: Readonly<AgentBackupRestoreV3CandidateFileTreeLimits>,
): Readonly<AgentBackupRestoreV3CandidateFileTreeFileSpec> {
  const snapshot = snapshotOwnDataRecord(
    value,
    ["path", "sizeBytes", "mode", "mtimeMs"],
    ["path", "sizeBytes", "mode", "mtimeMs"],
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_SPEC_INVALID",
    "Candidate file specification must contain exact enumerable data properties",
  );
  const filePath = snapshot.path;
  const sizeBytes = snapshot.sizeBytes;
  const mode = snapshot.mode;
  const mtimeMs = snapshot.mtimeMs;
  if (
    typeof filePath !== "string" ||
    !Number.isSafeInteger(sizeBytes) ||
    (sizeBytes as number) < 0 ||
    OBJECT_IS(sizeBytes, -0) ||
    (sizeBytes as number) > limits.maximumBytes ||
    !Number.isSafeInteger(mode) ||
    (mode as number) < 0 ||
    OBJECT_IS(mode, -0) ||
    (mode as number) > 0o777 ||
    !Number.isSafeInteger(mtimeMs) ||
    (mtimeMs as number) < 0 ||
    OBJECT_IS(mtimeMs, -0) ||
    (mtimeMs as number) > MAXIMUM_DATE_EPOCH_MS
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_SPEC_INVALID",
      "Candidate file specification is not exact and canonical",
    );
  }
  requireCanonicalFilePath(filePath, limits);
  return OBJECT_FREEZE({
    path: filePath,
    sizeBytes: sizeBytes as number,
    mode: mode as number,
    mtimeMs: mtimeMs as number,
  });
}

function parseExpectedProof(
  value: Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>,
  limits: Readonly<AgentBackupRestoreV3CandidateFileTreeLimits>,
): Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof> {
  const snapshot = snapshotOwnDataRecord(
    value,
    ["path", "sizeBytes", "mode", "mtimeMs", "sha256", "device", "inode"],
    ["path", "sizeBytes", "mode", "mtimeMs", "sha256", "device", "inode"],
    "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_PROOF_INVALID",
    "Candidate file proof must contain exact enumerable data properties",
  );
  if (
    typeof snapshot.sha256 !== "string" ||
    !SHA256_PATTERN.test(snapshot.sha256) ||
    typeof snapshot.device !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(snapshot.device) ||
    typeof snapshot.inode !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/.test(snapshot.inode)
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_PROOF_INVALID",
      "Candidate file proof is not exact and canonical",
    );
  }
  const spec = parseFileSpec(
    {
      path: snapshot.path as string,
      sizeBytes: snapshot.sizeBytes as number,
      mode: snapshot.mode as number,
      mtimeMs: snapshot.mtimeMs as number,
    },
    limits,
  );
  return OBJECT_FREEZE({
    ...spec,
    sha256: snapshot.sha256,
    device: snapshot.device,
    inode: snapshot.inode,
  });
}

function fileTreeFragmentByteLength(fragment: Uint8Array): number {
  if (
    IS_PROXY(fragment) ||
    !IS_UINT8_ARRAY(fragment) ||
    OBJECT_GET_PROTOTYPE_OF(fragment) !== INTRINSIC_UINT8_ARRAY.prototype ||
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(fragment, Symbol.iterator) !==
      undefined ||
    !TYPED_ARRAY_BYTE_LENGTH_GETTER ||
    !TYPED_ARRAY_BUFFER_GETTER ||
    !ARRAY_BUFFER_BYTE_LENGTH_GETTER
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_FRAGMENT_INVALID",
      "Candidate file-tree write requires one intrinsic bounded fragment",
    );
  }
  try {
    const buffer = REFLECT_APPLY(TYPED_ARRAY_BUFFER_GETTER, fragment, []);
    // Reject SharedArrayBuffer so the synchronous owned copy cannot be torn by
    // another agent while its size and bytes are observed.
    REFLECT_APPLY(ARRAY_BUFFER_BYTE_LENGTH_GETTER, buffer, []);
    return typedArrayByteLength(fragment);
  } catch (cause) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_FRAGMENT_INVALID",
      "Candidate file-tree fragment requires private non-shared storage",
      cause,
    );
  }
}

function copyFileTreeFragment(
  fragment: Uint8Array,
  byteLength: number,
): Uint8Array {
  const owned = new INTRINSIC_UINT8_ARRAY(byteLength);
  try {
    REFLECT_APPLY(UINT8_ARRAY_SET, owned, [fragment]);
  } catch (cause) {
    zeroBytes(owned);
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_FRAGMENT_INVALID",
      "Candidate file-tree fragment could not be copied exactly",
      cause,
    );
  }
  return owned;
}

async function readExactDirectoryNames(
  anchor: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  maximumNames: number,
  limitCode: string,
  limitMessage: string,
): Promise<string[]> {
  const directory = await controlledAcquire(
    () => fs.opendir(anchor, { encoding: BUFFER_DIRECTORY_ENCODING }),
    (lateDirectory) => lateDirectory.close(),
    control,
  );
  const names: string[] = [];
  try {
    while (true) {
      const entry = await controlled(() => directory.read(), control);
      if (entry === null) break;
      if (names.length >= maximumNames) {
        fileTreeError(limitCode, limitMessage);
      }
      const rawName = IS_UINT8_ARRAY(entry) ? entry : entry.name;
      if (!IS_UINT8_ARRAY(rawName)) {
        fileTreeError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_UNSAFE",
          "Candidate file-tree contains a non-UTF-8 or unsafe entry name",
        );
      }
      const encodedName = bufferFromArrayBuffer(
        typedArrayBuffer(rawName),
        typedArrayByteOffset(rawName),
        typedArrayByteLength(rawName),
      );
      let name: string;
      try {
        name = bufferToUtf8(encodedName);
        const roundTrip = bufferFromString(name, "utf8");
        try {
          if (bufferCompare(roundTrip, encodedName) !== 0) {
            fileTreeError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_UNSAFE",
              "Candidate file-tree contains a non-UTF-8 or unsafe entry name",
            );
          }
        } finally {
          zeroBytes(roundTrip);
        }
      } finally {
        zeroBytes(encodedName);
      }
      requirePathSegment(name, "candidate tree entry");
      names[names.length] = name;
    }
  } finally {
    await boundedInternalCleanup(() => directory.close());
  }
  return sortNames(names);
}

function sameStableDirectory(
  left: CandidateFsExactStats,
  right: CandidateFsExactStats,
): boolean {
  return (
    left.directory &&
    right.directory &&
    !left.symbolicLink &&
    !right.symbolicLink &&
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.linkCount === right.linkCount &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.changedNanoseconds === right.changedNanoseconds
  );
}

async function ensureDirectories(
  authority: AgentBackupRestoreV3CandidateFsControl,
  segments: readonly string[],
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<void> {
  const resolved: string[] = [];
  for (const rawSegment of segments) {
    const segment = requirePathSegment(rawSegment, "candidate directory");
    const parent = await authority.openDirectorySegments(resolved, control);
    try {
      const childPath = path.join(parent.anchor, segment);
      try {
        await controlled(() => fs.mkdir(childPath, { mode: 0o700 }), control);
      } catch (cause) {
        if (!isErrno(cause, "EEXIST")) throw cause;
      }
      // Sync both a fresh mkdir and its EEXIST replay. If mkdir reached the
      // kernel but the first call was cancelled before this fsync, only the
      // replay can make the parent dirent durably complete.
      await controlled(() => parent.handle.sync(), control);
    } finally {
      await boundedInternalCleanup(() => parent.handle.close());
    }
    resolved.push(segment);
    const child = await authority.openDirectorySegments(resolved, control);
    await boundedInternalCleanup(() => child.handle.close());
  }
}

function partialName(relativePath: string): string {
  return `${RESERVED_PREFIX}partial-${createHash("sha256")
    .update(relativePath, "utf8")
    .digest("hex")}`;
}

async function openBoundRegularFile(
  targetPath: string,
  flags: number,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  mode?: number,
): Promise<{
  readonly handle: FileHandle;
  readonly stats: CandidateFsExactStats;
}> {
  const handle = await controlledAcquire(
    () => fs.open(targetPath, flags, mode),
    (lateHandle) => lateHandle.close(),
    control,
  );
  try {
    const [visible, opened] = await controlled(
      () => Promise.all([lstatExact(targetPath), fileStatExact(handle)]),
      control,
    );
    if (!sameIdentity(visible, opened)) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
        "Candidate file pathname changed during no-follow open",
      );
    }
    return { handle, stats: opened };
  } catch (cause) {
    await boundedInternalCleanup(() => handle.close());
    throw cause;
  }
}

async function hashOpenedFile(
  handle: FileHandle,
  opened: CandidateFsExactStats,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<string> {
  const hash = createHash("sha256");
  const chunk = new INTRINSIC_UINT8_ARRAY(
    Math.min(CANDIDATE_FS_IO_CHUNK_BYTES, Math.max(1, opened.size)),
  );
  const chunkByteLength = typedArrayByteLength(chunk);
  const ioChunk = candidateFsNativeIoView(chunk);
  let position = 0;
  try {
    while (position < opened.size) {
      const requested = Math.min(chunkByteLength, opened.size - position);
      const read = await controlled(
        () => handle.read(ioChunk, 0, requested, position),
        control,
      );
      if (read.bytesRead <= 0) {
        fileTreeError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_TRUNCATED",
          "Candidate file ended during exact proof",
        );
      }
      hash.update(
        candidateFsNativeIoView(candidateFsByteView(chunk, 0, read.bytesRead)),
      );
      zeroBytes(chunk, 0, read.bytesRead);
      position += read.bytesRead;
    }
    return hash.digest("hex");
  } finally {
    zeroBytes(chunk);
  }
}

interface ProvenFileTreeFile {
  readonly proof: Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>;
  readonly stats: CandidateFsExactStats;
}

async function proveOpenedFile(
  handle: FileHandle,
  targetPath: string,
  expectedIdentity: CandidateFsExactStats,
  spec: Readonly<AgentBackupRestoreV3CandidateFileTreeFileSpec>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  allowStagingMode = false,
): Promise<Readonly<ProvenFileTreeFile>> {
  const [visible, before] = await controlled(
    () => Promise.all([lstatExact(targetPath), fileStatExact(handle)]),
    control,
  );
  requireRegularSingleLink(
    visible,
    "Candidate output path is not one regular single-link file",
  );
  requireRegularSingleLink(
    before,
    "Candidate output descriptor is not one regular single-link file",
  );
  if (
    !sameIdentity(visible, expectedIdentity) ||
    !sameIdentity(before, expectedIdentity) ||
    !sameIdentity(visible, before) ||
    visible.size !== spec.sizeBytes ||
    before.size !== spec.sizeBytes ||
    ((visible.mode & CANDIDATE_FILE_CONTROL_MODE_MASK) !== spec.mode &&
      (!allowStagingMode ||
        (visible.mode & CANDIDATE_FILE_CONTROL_MODE_MASK) !==
          CANDIDATE_FILE_STAGING_MODE)) ||
    ((before.mode & CANDIDATE_FILE_CONTROL_MODE_MASK) !== spec.mode &&
      (!allowStagingMode ||
        (before.mode & CANDIDATE_FILE_CONTROL_MODE_MASK) !==
          CANDIDATE_FILE_STAGING_MODE)) ||
    exactMtimeMs(visible) !== spec.mtimeMs ||
    exactMtimeMs(before) !== spec.mtimeMs
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
      "Candidate output differs from its exact path, size, mode, or mtime",
    );
  }
  if ((before.mode & CANDIDATE_FILE_CONTROL_MODE_MASK) !== spec.mode) {
    await controlled(() => handle.chmod(spec.mode), control);
    await controlled(() => handle.sync(), control);
  }
  // Take the hash baseline only after every intentional metadata mutation.
  // ctime can then close the entire content-proof window instead of being
  // invalidated by our own final chmod.
  const [visibleBeforeHash, beforeHash] = await controlled(
    () => Promise.all([lstatExact(targetPath), fileStatExact(handle)]),
    control,
  );
  requireRegularSingleLink(
    visibleBeforeHash,
    "Candidate output path changed before its final hash",
  );
  requireRegularSingleLink(
    beforeHash,
    "Candidate output descriptor changed before its final hash",
  );
  if (
    !sameIdentity(visibleBeforeHash, expectedIdentity) ||
    !sameStableFile(visibleBeforeHash, beforeHash) ||
    beforeHash.size !== spec.sizeBytes ||
    (beforeHash.mode & CANDIDATE_FILE_CONTROL_MODE_MASK) !== spec.mode ||
    exactMtimeMs(beforeHash) !== spec.mtimeMs
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
      "Candidate output differs before its final stable hash",
    );
  }
  const sha256 = await hashOpenedFile(handle, beforeHash, control);
  const [visibleAfterHash, afterHash] = await controlled(
    () => Promise.all([lstatExact(targetPath), fileStatExact(handle)]),
    control,
  );
  requireRegularSingleLink(
    visibleAfterHash,
    "Candidate output path changed during its final hash",
  );
  requireRegularSingleLink(
    afterHash,
    "Candidate output descriptor changed during its final hash",
  );
  if (
    !sameStableFile(beforeHash, afterHash) ||
    !sameStableFile(visibleBeforeHash, visibleAfterHash) ||
    !sameStableFile(visibleAfterHash, afterHash)
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
      "Candidate output changed during its final exact proof",
    );
  }
  return OBJECT_FREEZE({
    proof: OBJECT_FREEZE({
      ...spec,
      ...candidateFsIdentity(afterHash),
      sha256,
    }),
    stats: afterHash,
  });
}

async function proveFinalPath(
  targetPath: string,
  spec: Readonly<AgentBackupRestoreV3CandidateFileTreeFileSpec>,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
): Promise<Readonly<ProvenFileTreeFile>> {
  const visible = await controlled(() => lstatExact(targetPath), control);
  requireRegularSingleLink(
    visible,
    "Candidate final path is not one regular single-link file",
  );
  const visibleMode = visible.mode & CANDIDATE_FILE_CONTROL_MODE_MASK;
  if (
    visible.size !== spec.sizeBytes ||
    (visibleMode !== spec.mode &&
      visibleMode !== CANDIDATE_FILE_STAGING_MODE) ||
    exactMtimeMs(visible) !== spec.mtimeMs
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
      "Candidate final path differs from its exact size, mode, or mtime",
    );
  }

  if ((visibleMode & 0o444) !== 0) {
    const opened = await openBoundRegularFile(
      targetPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
      control,
    );
    try {
      return await proveOpenedFile(
        opened.handle,
        targetPath,
        visible,
        spec,
        control,
        true,
      );
    } finally {
      await boundedInternalCleanup(() => opened.handle.close());
    }
  }

  let authorityHandle: FileHandle | null = null;
  let readHandle: FileHandle | null = null;
  let restoreAnchor = targetPath;
  let restoreModeNeeded = false;
  let result: Readonly<ProvenFileTreeFile> | null = null;
  let primaryFailure: unknown;
  try {
    if (process.platform === "linux") {
      authorityHandle = await controlledAcquire(
        () => fs.open(targetPath, LINUX_O_PATH | constants.O_NOFOLLOW),
        (lateHandle) => lateHandle.close(),
        control,
      );
      const bound = await controlled(
        () => fileStatExact(authorityHandle as FileHandle),
        control,
      );
      requireRegularSingleLink(
        bound,
        "Candidate final O_PATH authority is not one regular single-link file",
      );
      if (!sameIdentity(bound, visible)) {
        fileTreeError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
          "Candidate final path changed during O_PATH binding",
        );
      }
      restoreAnchor = `/proc/self/fd/${authorityHandle.fd}`;
    }

    assertActive(control);
    await fs.chmod(restoreAnchor, CANDIDATE_FILE_STAGING_MODE);
    restoreModeNeeded = true;
    assertActive(control);
    readHandle = await controlledAcquire(
      () =>
        fs.open(
          restoreAnchor,
          process.platform === "linux"
            ? constants.O_RDONLY
            : constants.O_RDONLY | constants.O_NOFOLLOW,
        ),
      (lateHandle) => lateHandle.close(),
      control,
    );
    const opened = await controlled(
      () => fileStatExact(readHandle as FileHandle),
      control,
    );
    if (!sameIdentity(opened, visible)) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
        "Candidate final descriptor differs from its permission authority",
      );
    }
    result = await proveOpenedFile(
      readHandle,
      targetPath,
      visible,
      spec,
      control,
      true,
    );
    // proveOpenedFile restores and verifies the requested final mode before it
    // takes the stable ctime/hash baseline. Avoid a second chmod afterwards.
    restoreModeNeeded = false;
  } catch (cause) {
    primaryFailure = cause;
  }

  const cleanupOperations: Array<() => Promise<void>> = [];
  if (restoreModeNeeded) {
    cleanupOperations.push(() => fs.chmod(restoreAnchor, spec.mode));
  }
  if (readHandle) {
    const handleToClose = readHandle;
    readHandle = null;
    cleanupOperations.push(() => handleToClose.close());
  }
  if (authorityHandle) {
    const handleToClose = authorityHandle;
    authorityHandle = null;
    cleanupOperations.push(() => handleToClose.close());
  }
  let cleanupFailure: unknown;
  try {
    await runAllBoundedInternalCleanup(cleanupOperations);
  } catch (cause) {
    cleanupFailure = cause;
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CLEANUP_FAILED",
      "Candidate final proof and permission restoration both failed",
      new AggregateError([primaryFailure, cleanupFailure]),
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (!result) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
      "Candidate final permission proof ended without a result",
    );
  }
  const finalVisible = await controlled(() => lstatExact(targetPath), control);
  requireRegularSingleLink(
    finalVisible,
    "Candidate final path changed after permission-safe proof",
  );
  if (
    !sameStableFile(finalVisible, result.stats) ||
    !sameIdentity(finalVisible, visible)
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
      "Candidate final path changed after permission-safe proof",
    );
  }
  return OBJECT_FREEZE({ proof: result.proof, stats: finalVisible });
}

export class AgentBackupRestoreV3CandidateFileTreeWriter {
  readonly spec: Readonly<AgentBackupRestoreV3CandidateFileTreeFileSpec>;
  readonly replayed: boolean;
  #owner: AgentBackupRestoreV3CandidateFsControl;
  #parentHandle: FileHandle | null;
  #targetPath: string;
  #partialPath: string;
  #handle: FileHandle | null;
  #identity: CandidateFsExactStats | null;
  #lock: AgentBackupRestoreV3CandidateFsLock;
  #ownsLock: boolean;
  #position = 0;
  #replayedProof: Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof> | null;
  #writing = false;
  #closed = false;
  #finalizePromise: Promise<
    Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>
  > | null = null;
  #closePromise: Promise<void> | null = null;

  constructor(input: {
    owner: AgentBackupRestoreV3CandidateFsControl;
    parentHandle: FileHandle | null;
    targetPath: string;
    partialPath: string;
    handle: FileHandle | null;
    identity: CandidateFsExactStats | null;
    spec: Readonly<AgentBackupRestoreV3CandidateFileTreeFileSpec>;
    lock: AgentBackupRestoreV3CandidateFsLock;
    ownsLock: boolean;
    replayedProof?: Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>;
  }) {
    this.#owner = input.owner;
    this.#parentHandle = input.parentHandle;
    this.#targetPath = input.targetPath;
    this.#partialPath = input.partialPath;
    this.#handle = input.handle;
    this.#identity = input.identity;
    this.spec = input.spec;
    this.#lock = input.lock;
    this.#ownsLock = input.ownsLock;
    this.#replayedProof = input.replayedProof ?? null;
    this.replayed = this.#replayedProof !== null;
    OBJECT_FREEZE(this);
  }

  get acknowledgedBytes(): number {
    return this.#position;
  }

  write(
    fragment: Uint8Array,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<void> {
    const exactControl = snapshotOperationControl(control);
    const byteLength = fileTreeFragmentByteLength(fragment);
    if (byteLength === 0 || byteLength > CANDIDATE_FS_IO_CHUNK_BYTES) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_FRAGMENT_INVALID",
        "Candidate file-tree write requires one intrinsic bounded fragment",
      );
    }
    if (
      this.#closed ||
      this.#writing ||
      this.replayed ||
      !this.#handle ||
      !this.#identity ||
      this.#position > this.spec.sizeBytes - byteLength
    ) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_WRITER_INVALID",
        "Candidate file-tree writer state or byte bound is invalid",
      );
    }
    const owned = copyFileTreeFragment(fragment, byteLength);
    let releaseLockUse: () => void;
    try {
      releaseLockUse = this.#owner.beginLockUse(this.#lock);
    } catch (cause) {
      zeroBytes(owned);
      throw cause;
    }
    this.#writing = true;
    return (async () => {
      try {
        await this.#owner.assertLockHeld(this.#lock, exactControl);
        const before = await controlled(
          () => fileStatExact(this.#handle as FileHandle),
          exactControl,
        );
        requireRegularSingleLink(
          before,
          "Candidate partial changed before its descriptor-bound write",
        );
        if (!sameIdentity(before, this.#identity as CandidateFsExactStats)) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
            "Candidate partial inode changed before write",
          );
        }
        await writeAll(
          this.#handle as FileHandle,
          owned,
          this.#position,
          exactControl,
        );
        this.#position += byteLength;
        await this.#owner.assertLockHeld(this.#lock, exactControl);
      } catch (cause) {
        this.#closed = true;
        const disposal = this.#dispose(releaseLockUse);
        // write() is the sole reporter for a cleanup failure that it already
        // awaits and combines with the primary write failure. A later close()
        // only joins that completed cleanup; it must not publish the same
        // cleanup error again and let a materializer mask or double-count it.
        this.#closePromise = disposal.then(
          () => undefined,
          () => undefined,
        );
        try {
          await disposal;
        } catch (cleanupCause) {
          throw new AgentBackupRestoreV3CandidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CLEANUP_FAILED",
            "Candidate file write and bounded cleanup both failed",
            { cause: new AggregateError([cause, cleanupCause]) },
          );
        }
        throw cause;
      } finally {
        // The release closure is idempotent. On failure #dispose already ran
        // it after closing descriptors and before releasing an owned lease.
        releaseLockUse();
        zeroBytes(owned);
        this.#writing = false;
      }
    })();
  }

  finalize(
    control: Readonly<AgentBackupRestoreV3OperationControl>,
  ): Promise<Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>> {
    if (this.#finalizePromise) return this.#finalizePromise;
    if (this.#closed || this.#writing) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_WRITER_INVALID",
        "Candidate file-tree writer cannot finalize in its current state",
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
  ): Promise<Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>> {
    let result: Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof> | null =
      null;
    let primaryFailure: unknown;
    try {
      await this.#owner.assertLockHeld(this.#lock, control);
      if (this.#replayedProof) {
        result = this.#replayedProof;
      } else {
        if (
          !this.#handle ||
          !this.#identity ||
          !this.#parentHandle ||
          this.#position !== this.spec.sizeBytes
        ) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_TRUNCATED",
            "Candidate file-tree writer did not receive the exact file size",
          );
        }
        await applyExactMtimeMs(
          this.#handle as FileHandle,
          this.spec.mtimeMs,
          control,
        );
        await controlled(() => (this.#handle as FileHandle).sync(), control);
        const beforeLink = await controlled(
          () => fileStatExact(this.#handle as FileHandle),
          control,
        );
        if (
          !sameIdentity(beforeLink, this.#identity as CandidateFsExactStats) ||
          beforeLink.size !== this.spec.sizeBytes ||
          (beforeLink.mode & CANDIDATE_FILE_CONTROL_MODE_MASK) !==
            CANDIDATE_FILE_STAGING_MODE ||
          exactMtimeMs(beforeLink) !== this.spec.mtimeMs
        ) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_METADATA_CHANGED",
            "Candidate partial differs from its finalized metadata",
          );
        }
        try {
          await controlled(
            () => fs.link(this.#partialPath, this.#targetPath),
            control,
          );
        } catch (cause) {
          if (!isErrno(cause, "EEXIST")) throw cause;
          const target = await lstatExact(this.#targetPath);
          if (!sameIdentity(target, beforeLink) || target.linkCount !== 2) {
            fileTreeError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONFLICT",
              "Candidate final path was occupied by another inode",
              cause,
            );
          }
        }
        const linked = await controlled(
          () => fileStatExact(this.#handle as FileHandle),
          control,
        );
        if (!sameIdentity(linked, beforeLink) || linked.linkCount !== 2) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
            "Candidate file did not enter its exact two-link publish state",
          );
        }
        assertActive(control);
        await fs.unlink(this.#partialPath);
        await controlled(
          () => (this.#parentHandle as FileHandle).sync(),
          control,
        );
        const proven = await proveOpenedFile(
          this.#handle,
          this.#targetPath,
          this.#identity,
          this.spec,
          control,
          true,
        );
        result = proven.proof;
      }
    } catch (cause) {
      primaryFailure = cause;
    }
    const disposal = this.#dispose(releaseLockUse);
    try {
      await disposal;
    } catch (cleanupCause) {
      if (primaryFailure !== undefined) {
        throw new AgentBackupRestoreV3CandidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CLEANUP_FAILED",
          "Candidate file finalization and bounded cleanup both failed",
          { cause: new AggregateError([primaryFailure, cleanupCause]) },
        );
      }
      throw cleanupCause;
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (!result) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_WRITER_INVALID",
        "Candidate file finalization ended without an exact proof",
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
        fileTreeError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_WRITER_INVALID",
          "Candidate file-tree writer cannot close during a write",
        );
      } catch (cause) {
        return Promise.reject(cause);
      }
    }
    if (this.#closed) {
      this.#closePromise = Promise.resolve();
      return this.#closePromise;
    }
    let releaseLockUse: (() => void) | undefined;
    let lockFailure: unknown;
    try {
      releaseLockUse = this.#owner.beginLockUse(this.#lock);
    } catch (cause) {
      lockFailure = cause;
    }
    this.#closed = true;
    const disposal = this.#dispose(releaseLockUse);
    this.#closePromise =
      lockFailure === undefined
        ? disposal
        : disposal.then(
            () => Promise.reject(lockFailure),
            (cleanupCause) =>
              Promise.reject(
                new AgentBackupRestoreV3CandidateFsError(
                  "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CLEANUP_FAILED",
                  "Candidate file close lost its lock and bounded cleanup also failed",
                  { cause: new AggregateError([lockFailure, cleanupCause]) },
                ),
              ),
          );
    return this.#closePromise;
  }

  async #dispose(releaseLockUse?: () => void): Promise<void> {
    const cleanupOperations: Array<() => Promise<void>> = [];
    const handle = this.#handle;
    this.#handle = null;
    if (handle) {
      cleanupOperations.push(() => handle.close());
    }
    const parent = this.#parentHandle;
    this.#parentHandle = null;
    if (parent) {
      cleanupOperations.push(() => parent.close());
    }
    if (releaseLockUse) {
      cleanupOperations.push(async () => releaseLockUse());
    }
    if (this.#ownsLock) {
      this.#ownsLock = false;
      cleanupOperations.push(() =>
        this.#lock.release(internalCleanupControl()),
      );
    }
    await runAllBoundedInternalCleanup(cleanupOperations);
  }
}

export async function ensureCandidateFsFileTreeDirectory(
  authority: AgentBackupRestoreV3CandidateFsControl,
  relativeDirectory: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<void> {
  const exactControl = snapshotOperationControl(control);
  const segments = requireRelativePath(
    relativeDirectory,
    "candidate file-tree directory",
  ).split(path.sep);
  await authority.assertAuthority(exactControl);
  const operationLock = await authority.operationLock(
    `.file-tree-${createHash("sha256")
      .update(relativeDirectory)
      .digest("hex")
      .slice(0, 16)}`,
    exactControl,
    heldLock,
  );
  const activeLock = operationLock ?? heldLock;
  if (!activeLock) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
      "Candidate file-tree directory did not obtain its exact inode lock",
    );
  }
  let releaseLockUse: (() => void) | null = null;
  try {
    releaseLockUse = authority.beginLockUse(activeLock);
    await ensureDirectories(authority, segments, exactControl);
    await authority.assertLockHeld(activeLock, exactControl);
  } finally {
    const cleanupOperations: Array<() => Promise<void>> = [];
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
    await runAllBoundedInternalCleanup(cleanupOperations);
  }
}

export async function createCandidateFsFileTreeFile(
  authority: AgentBackupRestoreV3CandidateFsControl,
  relativeDirectory: string,
  specValue: Readonly<AgentBackupRestoreV3CandidateFileTreeFileSpec>,
  limitsValue: Partial<AgentBackupRestoreV3CandidateFileTreeLimits> | undefined,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<AgentBackupRestoreV3CandidateFileTreeWriter> {
  const exactControl = snapshotOperationControl(control);
  const limits = resolveLimits(limitsValue);
  const spec = parseFileSpec(specValue, limits);
  const rootSegments = requireRelativePath(
    relativeDirectory,
    "candidate file-tree directory",
  ).split(path.sep);
  const fileSegments = requireCanonicalFilePath(spec.path, limits);
  await authority.assertAuthority(exactControl);
  const operationLock = await authority.operationLock(
    `.file-${createHash("sha256")
      .update(relativeDirectory)
      .update("\0")
      .update(spec.path)
      .digest("hex")
      .slice(0, 16)}`,
    exactControl,
    heldLock,
  );
  const activeLock = operationLock ?? heldLock;
  if (!activeLock) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
      "Candidate file writer did not obtain its exact inode lock",
    );
  }
  let parentHandle: FileHandle | null = null;
  let handle: FileHandle | null = null;
  let releaseLockUse: (() => void) | null = null;
  try {
    releaseLockUse = authority.beginLockUse(activeLock);
    const parentSegments = [...rootSegments, ...fileSegments.slice(0, -1)];
    await ensureDirectories(authority, parentSegments, exactControl);
    const parent = await authority.openDirectorySegments(
      parentSegments,
      exactControl,
    );
    parentHandle = parent.handle;
    const fileName = fileSegments[fileSegments.length - 1] as string;
    const targetPath = path.join(parent.anchor, fileName);
    const partialPath = path.join(parent.anchor, partialName(spec.path));

    let targetStats: CandidateFsExactStats | null = null;
    try {
      targetStats = await controlled(
        () => lstatExact(targetPath),
        exactControl,
      );
    } catch (cause) {
      if (!isErrno(cause, "ENOENT")) throw cause;
    }
    if (targetStats) {
      let partialStats: CandidateFsExactStats | null = null;
      try {
        partialStats = await controlled(
          () => lstatExact(partialPath),
          exactControl,
        );
      } catch (cause) {
        if (!isErrno(cause, "ENOENT")) throw cause;
      }
      if (partialStats) {
        if (
          !sameIdentity(partialStats, targetStats) ||
          partialStats.linkCount !== 2 ||
          !partialStats.file ||
          partialStats.symbolicLink
        ) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONFLICT",
            "Candidate final and partial paths do not describe one crash state",
          );
        }
        assertActive(exactControl);
        await fs.unlink(partialPath);
        await controlled(
          () => (parentHandle as FileHandle).sync(),
          exactControl,
        );
        targetStats = await controlled(
          () => lstatExact(targetPath),
          exactControl,
        );
      }
      requireRegularSingleLink(
        targetStats,
        "Candidate final path is a symbolic link, hardlink, or non-regular file",
      );
      if (!partialStats) {
        // A previous finalize may have unlinked its partial and then lost its
        // response before synchronizing the parent directory. Replaying a
        // target-only state must make that final dirent durable before it can
        // return an exact proof.
        await controlled(
          () => (parentHandle as FileHandle).sync(),
          exactControl,
        );
      }
      const proven = await proveFinalPath(targetPath, spec, exactControl);
      await authority.assertLockHeld(activeLock, exactControl);
      const writer = new AgentBackupRestoreV3CandidateFileTreeWriter({
        owner: authority,
        parentHandle,
        targetPath,
        partialPath,
        handle: null,
        identity: null,
        spec,
        lock: activeLock,
        ownsLock: operationLock !== null,
        replayedProof: proven.proof,
      });
      parentHandle = null;
      releaseLockUse();
      releaseLockUse = null;
      return writer;
    }

    try {
      const opened = await openBoundRegularFile(
        partialPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
        exactControl,
      );
      handle = opened.handle;
      requireRegularSingleLink(
        opened.stats,
        "Candidate recoverable partial is not one regular single-link file",
      );
      await controlled(() => (handle as FileHandle).truncate(0), exactControl);
      await controlled(() => (handle as FileHandle).chmod(0o600), exactControl);
    } catch (cause) {
      if (!isErrno(cause, "ENOENT")) throw cause;
      const opened = await openBoundRegularFile(
        partialPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_RDWR |
          constants.O_NOFOLLOW,
        exactControl,
        0o600,
      );
      handle = opened.handle;
      requireRegularSingleLink(
        opened.stats,
        "Candidate newly-created partial is not one regular single-link file",
      );
    }
    const identity = await controlled(
      () => fileStatExact(handle as FileHandle),
      exactControl,
    );
    requireRegularSingleLink(
      identity,
      "Candidate partial changed before writer handoff",
    );
    if (identity.size !== 0) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONFLICT",
        "Candidate recoverable partial could not be reset exactly",
      );
    }
    await controlled(() => (parentHandle as FileHandle).sync(), exactControl);
    await authority.assertLockHeld(activeLock, exactControl);
    const writer = new AgentBackupRestoreV3CandidateFileTreeWriter({
      owner: authority,
      parentHandle,
      targetPath,
      partialPath,
      handle,
      identity,
      spec,
      lock: activeLock,
      ownsLock: operationLock !== null,
    });
    parentHandle = null;
    handle = null;
    releaseLockUse();
    releaseLockUse = null;
    return writer;
  } catch (cause) {
    const cleanupOperations: Array<() => Promise<void>> = [];
    if (handle) {
      const handleToClose = handle;
      handle = null;
      cleanupOperations.push(() => handleToClose.close());
    }
    if (parentHandle) {
      const handleToClose = parentHandle;
      parentHandle = null;
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
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CLEANUP_FAILED",
        "Candidate file writer setup and bounded cleanup both failed",
        { cause: new AggregateError([cause, cleanupCause]) },
      );
    }
    throw cause;
  }
}

function treeDigest(
  entries: readonly Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>[],
  directories: readonly Readonly<StableFileTreeDirectory>[],
): string {
  return createHash("sha256")
    .update(
      candidateFsCanonicalJson({
        derivation: FILE_TREE_DERIVATION,
        entries: entries.map((entry) => ({
          pathUtf8Hex: pathUtf8Hex(entry.path),
          sha256: entry.sha256,
          sizeBytes: entry.sizeBytes,
          mode: entry.mode,
          mtimeMs: entry.mtimeMs,
          device: entry.device,
          inode: entry.inode,
        })),
        directories: directories.map((entry) => ({
          pathUtf8Hex: pathUtf8Hex(entry.relativePath),
          device: entry.stats.device.toString(10),
          inode: entry.stats.inode.toString(10),
          mode: entry.stats.mode & CANDIDATE_FILE_CONTROL_MODE_MASK,
        })),
      }),
      "utf8",
    )
    .digest("hex");
}

export async function proveCandidateFsFileTree(
  authority: AgentBackupRestoreV3CandidateFsControl,
  relativeDirectory: string,
  expectedValue: readonly Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>[],
  limitsValue: Partial<AgentBackupRestoreV3CandidateFileTreeLimits> | undefined,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidateFileTreeProof>> {
  const exactControl = snapshotOperationControl(control);
  const limits = resolveLimits(limitsValue);
  if (
    IS_PROXY(expectedValue) ||
    !Array.isArray(expectedValue) ||
    OBJECT_GET_PROTOTYPE_OF(expectedValue) !== Array.prototype ||
    OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(expectedValue, Symbol.iterator) !==
      undefined
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT",
      "Candidate expected file list exceeds its explicit bound",
    );
  }
  const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    expectedValue,
    "length",
  );
  const expectedLength = lengthDescriptor?.value;
  if (
    !Number.isSafeInteger(expectedLength) ||
    (expectedLength as number) < 0 ||
    (expectedLength as number) > limits.maximumFiles ||
    Reflect.ownKeys(expectedValue).length !== (expectedLength as number) + 1
  ) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT",
      "Candidate expected file list exceeds its explicit bound",
    );
  }
  const expected: Readonly<AgentBackupRestoreV3CandidateFileTreeFileProof>[] =
    [];
  for (let index = 0; index < (expectedLength as number); index += 1) {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
      expectedValue,
      String(index),
    );
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_EXPECTATION_INVALID",
        "Candidate expected file list contains an accessor or sparse slot",
      );
    }
    expected.push(parseExpectedProof(descriptor.value, limits));
  }
  let expectedBytes = 0;
  const expectedDirectories = new Set<string>();
  for (const [index, entry] of expected.entries()) {
    expectedBytes += entry.sizeBytes;
    const segments = entry.path.split("/");
    let directoryPath = "";
    for (
      let segmentIndex = 0;
      segmentIndex < segments.length - 1;
      segmentIndex += 1
    ) {
      directoryPath = directoryPath
        ? `${directoryPath}/${segments[segmentIndex] as string}`
        : (segments[segmentIndex] as string);
      expectedDirectories.add(directoryPath);
    }
    if (
      expectedBytes > limits.maximumBytes ||
      expectedDirectories.size > limits.maximumDirectories ||
      (index > 0 &&
        compareAgentBackupCaptureV2FilePaths(
          expected[index - 1]?.path ?? "",
          entry.path,
        ) >= 0)
    ) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_EXPECTATION_INVALID",
        "Candidate expected files are duplicated, unordered, or oversized",
      );
    }
  }
  const expectedByPath = new Map(
    expected.map((entry) => [entry.path, entry] as const),
  );
  const rootSegments = requireRelativePath(
    relativeDirectory,
    "candidate file-tree directory",
  ).split(path.sep);
  await authority.assertAuthority(exactControl);
  const operationLock = await authority.operationLock(
    `.prove-files-${createHash("sha256")
      .update(relativeDirectory)
      .digest("hex")
      .slice(0, 16)}`,
    exactControl,
    heldLock,
  );
  const activeLock = operationLock ?? heldLock;
  if (!activeLock) {
    fileTreeError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
      "Candidate file-tree proof did not obtain its exact inode lock",
    );
  }
  let rootHandle: FileHandle | null = null;
  let releaseLockUse: (() => void) | null = null;
  try {
    releaseLockUse = authority.beginLockUse(activeLock);
    const root = await authority.openDirectorySegments(
      rootSegments,
      exactControl,
    );
    rootHandle = root.handle;
    const observed: AgentBackupRestoreV3CandidateFileTreeFileProof[] = [];
    const stableFiles: Array<{
      readonly targetPath: string;
      readonly stats: CandidateFsExactStats;
    }> = [];
    const stableDirectories: StableFileTreeDirectory[] = [];
    let directories = 0;
    let bytes = 0;
    const walk = async (
      directoryHandle: FileHandle,
      anchor: string,
      testPath: string,
      relative: string,
      expectedDirectory: CandidateFsExactStats,
      depth: number,
    ): Promise<CandidateFsExactStats> => {
      if (depth > limits.maximumDepth) {
        fileTreeError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT",
          "Candidate file-tree exceeds its depth bound",
        );
      }
      const beforeNames = await readExactDirectoryNames(
        anchor,
        exactControl,
        Math.min(
          Number.MAX_SAFE_INTEGER,
          limits.maximumFiles -
            observed.length +
            (limits.maximumDirectories - directories),
        ),
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT",
        "Candidate file-tree exceeds its file or directory-count bound",
      );
      for (const name of beforeNames) {
        if (name.toLowerCase().startsWith(RESERVED_PREFIX)) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONTROL_RESIDUE",
            "Candidate file-tree contains an unpublished control partial",
          );
        }
        const childRelative = relative ? `${relative}/${name}` : name;
        const childSegments = requireCanonicalFilePath(childRelative, limits);
        const childPath = path.join(anchor, name);
        const visible = await controlled(
          () => lstatExact(childPath),
          exactControl,
        );
        if (visible.symbolicLink) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_UNSAFE",
            "Candidate file-tree contains a symbolic link",
          );
        }
        if (visible.directory) {
          if (!expectedDirectories.has(childRelative)) {
            fileTreeError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONFLICT",
              "Candidate file-tree contains an unmanifested directory",
            );
          }
          const child = await controlledAcquire(
            () =>
              fs.open(
                childPath,
                constants.O_RDONLY |
                  constants.O_DIRECTORY |
                  constants.O_NOFOLLOW,
              ),
            (lateHandle) => lateHandle.close(),
            exactControl,
          );
          try {
            const opened = await controlled(
              () => fileStatExact(child),
              exactControl,
            );
            requirePrivateDirectory(
              opened,
              "Candidate file-tree directory is not private",
            );
            if (!sameIdentity(opened, visible)) {
              fileTreeError(
                "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
                "Candidate directory changed during no-follow descent",
              );
            }
            directories += 1;
            if (directories > limits.maximumDirectories) {
              fileTreeError(
                "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT",
                "Candidate file-tree directory count exceeds its derived bound",
              );
            }
            const stableDirectory = await walk(
              child,
              authority.directoryAnchor(child, path.join(testPath, name)),
              path.join(testPath, name),
              childRelative,
              opened,
              depth + 1,
            );
            stableDirectories.push(
              OBJECT_FREEZE({
                relativePath: childRelative,
                targetPath: path.join(root.anchor, ...childSegments),
                stats: stableDirectory,
              }),
            );
          } finally {
            await boundedInternalCleanup(() => child.close());
          }
          continue;
        }
        requireRegularSingleLink(
          visible,
          "Candidate file-tree contains a linked or non-regular file",
        );
        const expectation = expectedByPath.get(childRelative);
        if (
          !expectation ||
          observed.some((entry) => entry.path === childRelative)
        ) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONFLICT",
            "Candidate file-tree contains an unexpected or unordered file",
          );
        }
        const proven = await proveFinalPath(
          childPath,
          expectation,
          exactControl,
        );
        const proof = proven.proof;
        if (
          proof.sha256 !== expectation.sha256 ||
          proof.device !== expectation.device ||
          proof.inode !== expectation.inode
        ) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONFLICT",
            "Candidate file differs from its immutable expected proof",
          );
        }
        observed.push(proof);
        stableFiles.push(
          OBJECT_FREEZE({
            targetPath: path.join(root.anchor, ...childSegments),
            stats: proven.stats,
          }),
        );
        bytes += proof.sizeBytes;
        if (
          observed.length > limits.maximumFiles ||
          bytes > limits.maximumBytes
        ) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_LIMIT",
            "Candidate file-tree exceeds its file or byte bound",
          );
        }
      }
      const afterNames = await readExactDirectoryNames(
        anchor,
        exactControl,
        beforeNames.length,
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
        "Candidate file-tree gained an entry during exact proof",
      );
      const afterDirectory = await controlled(
        () => fileStatExact(directoryHandle),
        exactControl,
      );
      let sameNames = beforeNames.length === afterNames.length;
      for (let index = 0; sameNames && index < beforeNames.length; index += 1) {
        sameNames = beforeNames[index] === afterNames[index];
      }
      if (
        !sameNames ||
        !sameStableDirectory(afterDirectory, expectedDirectory)
      ) {
        fileTreeError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
          "Candidate directory changed during exact proof",
        );
      }
      requirePrivateDirectory(
        afterDirectory,
        "Candidate file-tree directory ceased to be private during proof",
      );
      return afterDirectory;
    };
    const stableRoot = await walk(
      root.handle,
      root.anchor,
      root.testPath,
      "",
      root.stats,
      0,
    );
    stableDirectories.push(
      OBJECT_FREEZE({
        relativePath: ".",
        targetPath: root.testPath,
        stats: stableRoot,
      }),
    );
    REFLECT_APPLY(ARRAY_SORT, stableDirectories, [
      (left: StableFileTreeDirectory, right: StableFileTreeDirectory) =>
        compareNames(left.relativePath, right.relativePath),
    ]);
    observed.sort((left, right) =>
      compareAgentBackupCaptureV2FilePaths(left.path, right.path),
    );
    if (
      observed.length !== expected.length ||
      bytes !== expectedBytes ||
      directories !== expectedDirectories.size
    ) {
      fileTreeError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONFLICT",
        "Candidate file-tree is incomplete",
      );
    }
    for (const [index, proof] of observed.entries()) {
      if (proof.path !== expected[index]?.path) {
        fileTreeError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_CONFLICT",
          "Candidate file-tree differs from canonical full-path UTF-8 order",
        );
      }
    }
    await authority.assertLockHeld(activeLock, exactControl);
    const reboundRoot = await authority.openDirectorySegments(
      rootSegments,
      exactControl,
    );
    try {
      const nestedDirectories = stableDirectories.filter(
        (entry) => entry.relativePath !== ".",
      );
      // Queue the last pathname/descriptor observations together after the
      // root rebind. This closes deterministic gaps between files and nested
      // directories for every writer that honors the quarantine lock. POSIX
      // provides no atomic multi-inode snapshot against a raw writer that
      // deliberately ignores that advisory boundary; CandidateFs documents
      // the stopped/inaccessible quarantine precondition explicitly.
      const [finalFiles, finalDirectories, rootPair] = await controlled(
        () =>
          Promise.all([
            Promise.all(
              stableFiles.map((entry) => lstatExact(entry.targetPath)),
            ),
            Promise.all(
              nestedDirectories.map((entry) => lstatExact(entry.targetPath)),
            ),
            Promise.all([
              fileStatExact(root.handle),
              fileStatExact(reboundRoot.handle),
            ]),
          ]),
        exactControl,
      );
      for (let index = 0; index < stableFiles.length; index += 1) {
        const finalFile = finalFiles[index] as CandidateFsExactStats;
        const stableFile = stableFiles[index] as (typeof stableFiles)[number];
        requireRegularSingleLink(
          finalFile,
          "Candidate file-tree file changed after its exact proof",
        );
        if (!sameStableFile(finalFile, stableFile.stats)) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
            "Candidate file-tree file changed after its exact proof",
          );
        }
      }
      for (let index = 0; index < nestedDirectories.length; index += 1) {
        const finalDirectory = finalDirectories[index] as CandidateFsExactStats;
        const stableDirectory = nestedDirectories[
          index
        ] as StableFileTreeDirectory;
        requirePrivateDirectory(
          finalDirectory,
          "Candidate file-tree directory ceased to be private",
        );
        if (!sameStableDirectory(finalDirectory, stableDirectory.stats)) {
          fileTreeError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
            "Candidate nested directory changed after its exact proof",
          );
        }
      }
      const rootAfter = rootPair[0] as CandidateFsExactStats;
      const reboundAfter = rootPair[1] as CandidateFsExactStats;
      if (
        !sameStableDirectory(rootAfter, stableRoot) ||
        !sameStableDirectory(reboundRoot.stats, reboundAfter) ||
        !sameStableDirectory(reboundAfter, rootAfter)
      ) {
        fileTreeError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FILE_TREE_INODE_CHANGED",
          "Candidate file-tree root pathname changed during exact proof",
        );
      }
      return OBJECT_FREEZE({
        derivation: FILE_TREE_DERIVATION,
        ...candidateFsIdentity(rootAfter),
        sha256: treeDigest(observed, stableDirectories),
        bytes,
        files: observed.length,
        directories,
        entries: Object.freeze(observed.map((entry) => Object.freeze(entry))),
      });
    } finally {
      await boundedInternalCleanup(() => reboundRoot.handle.close());
    }
  } finally {
    const cleanupOperations: Array<() => Promise<void>> = [];
    if (rootHandle) {
      const handleToClose = rootHandle;
      rootHandle = null;
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
    await runAllBoundedInternalCleanup(cleanupOperations);
  }
}
