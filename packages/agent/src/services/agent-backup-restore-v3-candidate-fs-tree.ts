/** Deterministic tree proof and bounded post-order volatile cleanup. */

import { Buffer } from "node:buffer";
import { type BinaryLike, createHash, Hash } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { types as utilTypes } from "node:util";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import {
  type AgentBackupRestoreV3CandidateFsControl,
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
  requirePathSegment,
  requirePositiveSafeInteger,
  requirePrivateDirectory,
  requirePrivateSingleLinkFile,
  requireRelativePath,
  runAllBoundedInternalCleanup,
  sameIdentity,
  sameStableFile,
  snapshotOwnDataRecord,
  syncDirectory,
} from "./agent-backup-restore-v3-candidate-fs-control";

const MAX_RELATIVE_PATH_BYTES = 1_024;
const BUFFER_DIRECTORY_ENCODING = "buffer" as BufferEncoding;
const TREE_PROOF_DERIVATION =
  "elizaos.agent-backup.restore-v3-candidate-tree.v1";
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_SLICE = Array.prototype.slice;
const ARRAY_SORT = Array.prototype.sort;
const IS_PROXY = utilTypes.isProxy;
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
const CREATE_HASH = createHash;
const HASH_UPDATE = Hash.prototype.update as (
  data: BinaryLike,
  inputEncoding?: BufferEncoding,
) => Hash;
const HASH_DIGEST_HEX = Hash.prototype.digest as (encoding: "hex") => string;
const INTRINSIC_UINT8_ARRAY = Uint8Array;
const INTRINSIC_SET = Set;
const SET_ADD = Set.prototype.add;
const SET_HAS = Set.prototype.has;
const STRING_SLICE = String.prototype.slice;
const STRING_SPLIT = String.prototype.split;
const PATH_JOIN = path.join;
const PATH_SEPARATOR = path.sep;
const UINT8_ARRAY_SET = Uint8Array.prototype.set;
const UINT8_ARRAY_FILL = Uint8Array.prototype.fill;
const UTF8_ENCODER = new TextEncoder();
const TEXT_ENCODER_ENCODE = TextEncoder.prototype.encode;
const BUFFER_ALLOC = Buffer.alloc;
const BUFFER_FROM = Buffer.from;
const BUFFER_BYTE_LENGTH = Buffer.byteLength;
const BUFFER_COMPARE = Buffer.compare;
const BUFFER_TO_STRING = Buffer.prototype.toString;
const BUFFER_WRITE_BIG_UINT64_BE = Buffer.prototype.writeBigUInt64BE;
const IS_UINT8_ARRAY = utilTypes.isUint8Array;
const TREE_DIRECTORY_MARKER = candidateFsNativeIoView(
  new INTRINSIC_UINT8_ARRAY([0x44]),
);
const TREE_FILE_MARKER = candidateFsNativeIoView(
  new INTRINSIC_UINT8_ARRAY([0x46]),
);

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

function sha256Hex(data: BinaryLike, inputEncoding?: BufferEncoding): string {
  return hashDigestHex(updateHash(createSha256Hash(), data, inputEncoding));
}

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

function bufferAlloc(byteLength: number): Buffer {
  return REFLECT_APPLY(BUFFER_ALLOC, Buffer, [byteLength]);
}

function bufferFromUtf8String(value: string): Buffer {
  const encoded = REFLECT_APPLY(TEXT_ENCODER_ENCODE, UTF8_ENCODER, [value]);
  try {
    const owned = bufferAlloc(typedArrayByteLength(encoded));
    REFLECT_APPLY(UINT8_ARRAY_SET, owned, [encoded]);
    return owned;
  } finally {
    zeroBytes(encoded);
  }
}

function bufferFromArrayBuffer(
  value: ArrayBufferLike,
  byteOffset: number,
  byteLength: number,
): Buffer {
  return REFLECT_APPLY(BUFFER_FROM, Buffer, [value, byteOffset, byteLength]);
}

function bufferUtf8ByteLength(value: string): number {
  return REFLECT_APPLY(BUFFER_BYTE_LENGTH, Buffer, [value, "utf8"]);
}

function bufferCompare(left: Uint8Array, right: Uint8Array): number {
  return REFLECT_APPLY(BUFFER_COMPARE, Buffer, [left, right]);
}

function bufferToUtf8(value: Buffer): string {
  return REFLECT_APPLY(BUFFER_TO_STRING, value, ["utf8"]);
}

function writeBigUint64(value: Buffer, integer: bigint): void {
  REFLECT_APPLY(BUFFER_WRITE_BIG_UINT64_BE, value, [integer, 0]);
}

function arraySlice<T>(value: readonly T[], start: number, end?: number): T[] {
  return REFLECT_APPLY(
    ARRAY_SLICE,
    value,
    end === undefined ? [start] : [start, end],
  );
}

function sortNames(value: string[]): string[] {
  REFLECT_APPLY(ARRAY_SORT, value, [compareNames]);
  return value;
}

function setAdd<T>(value: Set<T>, entry: T): void {
  REFLECT_APPLY(SET_ADD, value, [entry]);
}

function setHas<T>(value: Set<T>, entry: T): boolean {
  return REFLECT_APPLY(SET_HAS, value, [entry]);
}

function stringSlice(value: string, start: number, end?: number): string {
  return REFLECT_APPLY(
    STRING_SLICE,
    value,
    end === undefined ? [start] : [start, end],
  );
}

function stringSplit(value: string, separator: string): string[] {
  return REFLECT_APPLY(STRING_SPLIT, value, [separator]);
}

export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS = OBJECT_FREEZE({
  maximumBytes: 8 * 1024 * 1024 * 1024,
  maximumFiles: 100_000,
  maximumDirectories: 16_384,
  maximumDepth: 32,
  maximumPathBytes: MAX_RELATIVE_PATH_BYTES,
});

export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_CLEANUP_LIMITS = OBJECT_FREEZE({
  maximumBytes: 8 * 1024 * 1024 * 1024,
  maximumEntries: 100_000,
  maximumDepth: 32,
});

export interface AgentBackupRestoreV3CandidateTreeLimits {
  readonly maximumBytes: number;
  readonly maximumFiles: number;
  readonly maximumDirectories: number;
  readonly maximumDepth: number;
  readonly maximumPathBytes: number;
}

export interface AgentBackupRestoreV3CandidateTreeProof
  extends AgentBackupRestoreV3CandidateFsIdentity {
  readonly derivation: typeof TREE_PROOF_DERIVATION;
  readonly sha256: string;
  readonly bytes: number;
  readonly files: number;
  /** Descendant directories; the proved root is not included. */
  readonly directories: number;
}

export interface AgentBackupRestoreV3CandidateCleanupLimits {
  readonly maximumBytes: number;
  readonly maximumEntries: number;
  readonly maximumDepth: number;
}

export interface AgentBackupRestoreV3CandidateCleanupReceipt {
  readonly removedBytes: number;
  readonly removedEntries: number;
}

interface CleanupEntry {
  readonly segments: readonly string[];
  readonly parentStats: CandidateFsExactStats;
  readonly kind: "directory" | "file";
  readonly stats: CandidateFsExactStats;
}

function snapshotCleanupNames(value: readonly string[]): readonly string[] {
  if (IS_PROXY(value) || !ARRAY_IS_ARRAY(value)) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
      "Candidate volatile cleanup requires at most 64 explicit paths",
    );
  }
  const lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 64) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
      "Candidate volatile cleanup requires at most 64 explicit paths",
    );
  }
  const unique = new INTRINSIC_SET<string>();
  const names: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_UNSAFE",
        "Candidate volatile cleanup requires dense data-property paths",
      );
    }
    const name = requireControlName(descriptor.value, "volatile path name");
    if (setHas(unique, name)) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_UNSAFE",
        "Candidate volatile cleanup contains a duplicate path",
      );
    }
    setAdd(unique, name);
    names[names.length] = name;
  }
  return OBJECT_FREEZE(names);
}

function updateUint64(hash: Hash, value: number): void {
  const framed = bufferAlloc(8);
  try {
    writeBigUint64(framed, BigInt(value));
    updateHash(hash, candidateFsNativeIoView(framed));
  } finally {
    zeroBytes(framed);
  }
}

function updateTreeHeader(
  hash: Hash,
  kind: "directory" | "file",
  relativePath: string,
  mode: number,
  size: number,
): void {
  const encodedPath = bufferFromUtf8String(relativePath);
  try {
    updateHash(
      hash,
      kind === "directory" ? TREE_DIRECTORY_MARKER : TREE_FILE_MARKER,
    );
    updateUint64(hash, typedArrayByteLength(encodedPath));
    updateHash(hash, candidateFsNativeIoView(encodedPath));
    updateUint64(hash, mode & 0o777);
    updateUint64(hash, size);
  } finally {
    zeroBytes(encodedPath);
  }
}

function compareNames(left: string, right: string): number {
  const encodedLeft = bufferFromUtf8String(left);
  const encodedRight = bufferFromUtf8String(right);
  try {
    return bufferCompare(encodedLeft, encodedRight);
  } finally {
    zeroBytes(encodedLeft);
    zeroBytes(encodedRight);
  }
}

async function readExactDirectoryNames(
  anchor: string,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  maximumNames: number,
  limitCode: string,
  limitMessage: string,
  unsafeCode: string,
  unsafeMessage: string,
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
        candidateFsError(limitCode, limitMessage);
      }
      const rawName = IS_UINT8_ARRAY(entry) ? entry : entry.name;
      if (!IS_UINT8_ARRAY(rawName)) {
        candidateFsError(unsafeCode, unsafeMessage);
      }
      const encodedName = bufferFromArrayBuffer(
        typedArrayBuffer(rawName),
        typedArrayByteOffset(rawName),
        typedArrayByteLength(rawName),
      );
      let name: string;
      try {
        name = bufferToUtf8(encodedName);
        const roundTrip = bufferFromUtf8String(name);
        try {
          if (bufferCompare(roundTrip, encodedName) !== 0) {
            candidateFsError(unsafeCode, unsafeMessage);
          }
        } finally {
          zeroBytes(roundTrip);
        }
      } finally {
        zeroBytes(encodedName);
      }
      requirePathSegment(name, "candidate directory entry name");
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

function resolveTreeLimits(
  value: Partial<AgentBackupRestoreV3CandidateTreeLimits> | undefined,
): Readonly<AgentBackupRestoreV3CandidateTreeLimits> {
  const limits: Readonly<Record<string, unknown>> =
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
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LIMIT_INVALID",
          "Candidate tree limits must be exact data properties",
        );
  return OBJECT_FREEZE({
    maximumBytes: requirePositiveSafeInteger(
      (limits.maximumBytes as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS.maximumBytes,
      "maximumBytes",
    ),
    maximumFiles: requirePositiveSafeInteger(
      (limits.maximumFiles as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS.maximumFiles,
      "maximumFiles",
    ),
    maximumDirectories: requirePositiveSafeInteger(
      (limits.maximumDirectories as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS.maximumDirectories,
      "maximumDirectories",
    ),
    maximumDepth: requirePositiveSafeInteger(
      (limits.maximumDepth as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS.maximumDepth,
      "maximumDepth",
    ),
    maximumPathBytes: requirePositiveSafeInteger(
      (limits.maximumPathBytes as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS.maximumPathBytes,
      "maximumPathBytes",
    ),
  });
}

function resolveCleanupLimits(
  value: Partial<AgentBackupRestoreV3CandidateCleanupLimits> | undefined,
): Readonly<AgentBackupRestoreV3CandidateCleanupLimits> {
  const limits: Readonly<Record<string, unknown>> =
    value === undefined
      ? OBJECT_FREEZE({})
      : snapshotOwnDataRecord(
          value,
          ["maximumBytes", "maximumEntries", "maximumDepth"],
          [],
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LIMIT_INVALID",
          "Candidate cleanup limits must be exact data properties",
        );
  return OBJECT_FREEZE({
    maximumBytes: requirePositiveSafeInteger(
      (limits.maximumBytes as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_CLEANUP_LIMITS.maximumBytes,
      "maximumBytes",
    ),
    maximumEntries: requirePositiveSafeInteger(
      (limits.maximumEntries as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_CLEANUP_LIMITS.maximumEntries,
      "maximumEntries",
    ),
    maximumDepth: requirePositiveSafeInteger(
      (limits.maximumDepth as number | undefined) ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_CLEANUP_LIMITS.maximumDepth,
      "maximumDepth",
    ),
  });
}

export async function proveCandidateFsTree(
  authority: AgentBackupRestoreV3CandidateFsControl,
  relativeDirectory: string,
  limitsValue: Partial<AgentBackupRestoreV3CandidateTreeLimits> | undefined,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidateTreeProof>> {
  const limits = resolveTreeLimits(limitsValue);
  const normalizedDirectory = requireRelativePath(
    relativeDirectory,
    "tree directory",
  );
  const segments = stringSplit(normalizedDirectory, PATH_SEPARATOR);
  await authority.assertAuthority(control);
  const treeDerivation = sha256Hex(relativeDirectory);
  const operationLock = await authority.operationLock(
    `.tree-${stringSlice(treeDerivation, 0, 16)}`,
    control,
    heldLock,
  );
  const activeLock = operationLock ?? heldLock;
  if (!activeLock) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
      "Candidate tree proof did not obtain an exact inode-lock lease",
    );
  }
  let rootHandle: FileHandle | null = null;
  let releaseLockUse: (() => void) | null = null;
  try {
    releaseLockUse = authority.beginLockUse(activeLock);
    const root = await authority.openDirectorySegments(segments, control);
    rootHandle = root.handle;
    const hash = createSha256Hash();
    updateHash(hash, TREE_PROOF_DERIVATION, "utf8");
    updateTreeHeader(hash, "directory", ".", root.stats.mode, 0);
    let bytes = 0;
    let files = 0;
    let directories = 0;

    const walk = async (
      handle: FileHandle,
      anchor: string,
      testPath: string,
      relative: string,
      expectedDirectory: CandidateFsExactStats,
      depth: number,
    ): Promise<void> => {
      if (depth > limits.maximumDepth) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_LIMIT",
          "Candidate tree exceeds its depth bound",
        );
      }
      const firstNames = await readExactDirectoryNames(
        anchor,
        control,
        Math.min(
          Number.MAX_SAFE_INTEGER,
          limits.maximumFiles -
            files +
            (limits.maximumDirectories - directories),
        ),
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_LIMIT",
        "Candidate tree exceeds its file or directory-count bound",
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_UNSAFE",
        "Candidate tree contains a non-UTF-8 or unsafe entry name",
      );
      for (const name of firstNames) {
        requirePathSegment(name, "tree entry name");
        const childRelative = relative ? `${relative}/${name}` : name;
        if (bufferUtf8ByteLength(childRelative) > limits.maximumPathBytes) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_LIMIT",
            "Candidate tree path exceeds its byte bound",
          );
        }
        const childPath = PATH_JOIN(anchor, name);
        const visible = await controlled(() => lstatExact(childPath), control);
        if (visible.symbolicLink) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_UNSAFE",
            "Candidate tree contains a symbolic link",
          );
        }
        if (visible.directory) {
          const childHandle = await controlledAcquire(
            () =>
              fs.open(
                childPath,
                constants.O_RDONLY |
                  constants.O_DIRECTORY |
                  constants.O_NOFOLLOW,
              ),
            (lateHandle) => lateHandle.close(),
            control,
          );
          try {
            const opened = await controlled(
              () => fileStatExact(childHandle),
              control,
            );
            requirePrivateDirectory(
              opened,
              "Candidate tree contains a non-private directory",
            );
            if (!sameIdentity(visible, opened)) {
              candidateFsError(
                "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_CHANGED",
                "Candidate tree directory changed while opening",
              );
            }
            directories += 1;
            if (directories > limits.maximumDirectories) {
              candidateFsError(
                "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_LIMIT",
                "Candidate tree exceeds its directory-count bound",
              );
            }
            updateTreeHeader(hash, "directory", childRelative, opened.mode, 0);
            const childTestPath = PATH_JOIN(testPath, name);
            await walk(
              childHandle,
              authority.directoryAnchor(childHandle, childTestPath),
              childTestPath,
              childRelative,
              opened,
              depth + 1,
            );
          } finally {
            await boundedInternalCleanup(() => childHandle.close());
          }
          continue;
        }
        requirePrivateSingleLinkFile(
          visible,
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_UNSAFE",
          "Candidate tree contains a non-private, linked, or non-regular file",
        );
        const fileHandle = await controlledAcquire(
          () => fs.open(childPath, constants.O_RDONLY | constants.O_NOFOLLOW),
          (lateHandle) => lateHandle.close(),
          control,
        );
        try {
          const opened = await assertBoundFile(
            fileHandle,
            childPath,
            visible,
            control,
          );
          requirePrivateSingleLinkFile(
            opened,
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_UNSAFE",
            "Candidate tree contains a non-private, linked, or non-regular file",
          );
          files += 1;
          bytes += opened.size;
          if (files > limits.maximumFiles || bytes > limits.maximumBytes) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_LIMIT",
              "Candidate tree exceeds its file or byte bound",
            );
          }
          updateTreeHeader(
            hash,
            "file",
            childRelative,
            opened.mode,
            opened.size,
          );
          const chunk = new INTRINSIC_UINT8_ARRAY(
            Math.min(CANDIDATE_FS_IO_CHUNK_BYTES, Math.max(1, opened.size)),
          );
          const chunkByteLength = typedArrayByteLength(chunk);
          const ioChunk = candidateFsNativeIoView(chunk);
          let position = 0;
          try {
            while (position < opened.size) {
              const requested = Math.min(
                chunkByteLength,
                opened.size - position,
              );
              const read = await controlled(
                () => fileHandle.read(ioChunk, 0, requested, position),
                control,
              );
              if (read.bytesRead <= 0) {
                candidateFsError(
                  "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_CHANGED",
                  "Candidate tree file ended while it was proved",
                );
              }
              updateHash(
                hash,
                candidateFsNativeIoView(
                  candidateFsByteView(chunk, 0, read.bytesRead),
                ),
              );
              zeroBytes(chunk, 0, read.bytesRead);
              position += read.bytesRead;
            }
          } finally {
            zeroBytes(chunk);
          }
          const after = await assertBoundFile(
            fileHandle,
            childPath,
            visible,
            control,
          );
          if (!sameStableFile(opened, after)) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_CHANGED",
              "Candidate tree file changed while it was proved",
            );
          }
        } finally {
          await boundedInternalCleanup(() => fileHandle.close());
        }
      }
      const secondNames = await readExactDirectoryNames(
        anchor,
        control,
        firstNames.length,
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_CHANGED",
        "Candidate tree gained an entry while it was proved",
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_UNSAFE",
        "Candidate tree contains a non-UTF-8 or unsafe entry name",
      );
      const afterDirectory = await controlled(
        () => fileStatExact(handle),
        control,
      );
      let sameNames = firstNames.length === secondNames.length;
      for (let index = 0; sameNames && index < firstNames.length; index += 1) {
        sameNames = firstNames[index] === secondNames[index];
      }
      if (
        !sameNames ||
        !sameStableDirectory(afterDirectory, expectedDirectory)
      ) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_CHANGED",
          "Candidate tree directory changed while it was proved",
        );
      }
    };

    await walk(root.handle, root.anchor, root.testPath, "", root.stats, 0);
    const finalRoot = await controlled(
      () => fileStatExact(root.handle),
      control,
    );
    if (!sameStableDirectory(finalRoot, root.stats)) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_CHANGED",
        "Candidate tree root identity changed",
      );
    }
    await authority.assertLockHeld(activeLock, control);
    return OBJECT_FREEZE({
      derivation: TREE_PROOF_DERIVATION,
      ...candidateFsIdentity(finalRoot),
      sha256: hashDigestHex(hash),
      bytes,
      files,
      directories,
    });
  } finally {
    const cleanupOperations: Array<() => Promise<void>> = [];
    const handleToClose = rootHandle;
    if (handleToClose) {
      cleanupOperations[cleanupOperations.length] = () => handleToClose.close();
    }
    if (releaseLockUse) {
      const releaseUse = releaseLockUse;
      releaseLockUse = null;
      cleanupOperations[cleanupOperations.length] = async () => releaseUse();
    }
    if (operationLock) {
      cleanupOperations[cleanupOperations.length] = () =>
        operationLock.release(internalCleanupControl());
    }
    await runAllBoundedInternalCleanup(cleanupOperations);
  }
}

export async function cleanupCandidateFsVolatile(
  authority: AgentBackupRestoreV3CandidateFsControl,
  names: readonly string[],
  limitsValue: Partial<AgentBackupRestoreV3CandidateCleanupLimits> | undefined,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  heldLock?: AgentBackupRestoreV3CandidateFsLock,
): Promise<Readonly<AgentBackupRestoreV3CandidateCleanupReceipt>> {
  const limits = resolveCleanupLimits(limitsValue);
  const cleanupNames = snapshotCleanupNames(names);
  const entries: CleanupEntry[] = [];
  let removedBytes = 0;
  await authority.assertAuthority(control);
  const operationLock = await authority.operationLock(
    ".cleanup",
    control,
    heldLock,
  );
  const activeLock = operationLock ?? heldLock;
  if (!activeLock) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LOCK_INVALID",
      "Candidate cleanup did not obtain an exact inode-lock lease",
    );
  }
  let releaseLockUse: (() => void) | null = null;
  try {
    releaseLockUse = authority.beginLockUse(activeLock);
    const scan = async (
      parentAnchor: string,
      parentTestPath: string,
      parentSegments: readonly string[],
      parentStats: CandidateFsExactStats,
      name: string,
      depth: number,
      knownStats?: CandidateFsExactStats,
    ): Promise<void> => {
      if (depth > limits.maximumDepth) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
          "Candidate volatile cleanup exceeds its depth bound",
        );
      }
      requirePathSegment(name, "volatile path segment");
      const target = PATH_JOIN(parentAnchor, name);
      const stats =
        knownStats ?? (await controlled(() => lstatExact(target), control));
      if (stats.symbolicLink) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_UNSAFE",
          "Candidate volatile cleanup refuses symbolic links",
        );
      }
      const segments = [...parentSegments, name];
      if (stats.directory) {
        const directoryHandle = await controlledAcquire(
          () =>
            fs.open(
              target,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            ),
          (lateHandle) => lateHandle.close(),
          control,
        );
        try {
          const opened = await controlled(
            () => fileStatExact(directoryHandle),
            control,
          );
          requirePrivateDirectory(
            opened,
            "Candidate volatile cleanup refuses a non-private directory",
          );
          if (!sameIdentity(stats, opened)) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_CHANGED",
              "Candidate volatile directory changed while opening",
            );
          }
          const testPath = PATH_JOIN(parentTestPath, name);
          const anchor = authority.directoryAnchor(directoryHandle, testPath);
          const children = await readExactDirectoryNames(
            anchor,
            control,
            Math.max(0, limits.maximumEntries - entries.length - 1),
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
            "Candidate volatile cleanup exceeds its entry bound",
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_UNSAFE",
            "Candidate volatile cleanup refuses a non-UTF-8 or unsafe entry name",
          );
          for (const child of children) {
            await scan(anchor, testPath, segments, opened, child, depth + 1);
          }
          const after = await controlled(
            () => fileStatExact(directoryHandle),
            control,
          );
          if (!sameStableDirectory(after, opened)) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_CHANGED",
              "Candidate volatile directory changed during preflight",
            );
          }
          entries[entries.length] = {
            segments,
            parentStats,
            kind: "directory",
            stats: opened,
          };
        } finally {
          await boundedInternalCleanup(() => directoryHandle.close());
        }
      } else {
        requirePrivateSingleLinkFile(
          stats,
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_UNSAFE",
          "Candidate volatile cleanup refuses a linked or non-regular file",
        );
        removedBytes += stats.size;
        entries[entries.length] = {
          segments,
          parentStats,
          kind: "file",
          stats,
        };
      }
      if (
        entries.length > limits.maximumEntries ||
        removedBytes > limits.maximumBytes
      ) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
          "Candidate volatile cleanup exceeds its entry or byte bound",
        );
      }
    };

    const root = await authority.openDirectorySegments([], control);
    try {
      for (const name of cleanupNames) {
        const target = PATH_JOIN(root.anchor, name);
        let rootStats: CandidateFsExactStats;
        try {
          rootStats = await controlled(() => lstatExact(target), control);
        } catch (cause) {
          if (isErrno(cause, "ENOENT")) continue;
          throw cause;
        }
        try {
          await scan(
            root.anchor,
            root.testPath,
            [],
            root.stats,
            name,
            0,
            rootStats,
          );
        } catch (cause) {
          if (isErrno(cause, "ENOENT")) {
            candidateFsError(
              "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_CHANGED",
              "Candidate volatile path disappeared during cleanup preflight",
              { cause },
            );
          }
          throw cause;
        }
      }
    } finally {
      await boundedInternalCleanup(() => root.handle.close());
    }

    assertActive(control);
    const cleanupControl = internalCleanupControl();
    for (const entry of entries) {
      await authority.assertLockHeld(activeLock, cleanupControl);
      const parent = await authority.openDirectorySegments(
        arraySlice(entry.segments, 0, -1),
        cleanupControl,
      );
      try {
        if (!sameIdentity(parent.stats, entry.parentStats)) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_CHANGED",
            "Candidate volatile parent directory changed before removal",
          );
        }
        const target = PATH_JOIN(
          parent.anchor,
          entry.segments[entry.segments.length - 1] as string,
        );
        const current = await lstatExact(target);
        if (entry.kind === "directory") {
          requirePrivateDirectory(
            current,
            "Candidate volatile directory is no longer private before removal",
          );
        }
        if (
          !sameIdentity(current, entry.stats) ||
          current.symbolicLink ||
          (entry.kind === "file" &&
            (!current.file ||
              current.linkCount !== 1 ||
              !sameStableFile(current, entry.stats))) ||
          (entry.kind === "directory" && !current.directory)
        ) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_CHANGED",
            "Candidate volatile path changed before removal",
          );
        }
        if (entry.kind === "file") await fs.unlink(target);
        else await fs.rmdir(target);
      } finally {
        await boundedInternalCleanup(() => parent.handle.close());
      }
    }
    await authority.assertLockHeld(activeLock, cleanupControl);
    await syncDirectory(authority.attemptAuthority, cleanupControl);
    assertActive(control);
    return OBJECT_FREEZE({
      removedBytes,
      removedEntries: entries.length,
    });
  } finally {
    releaseLockUse?.();
    if (operationLock) {
      await operationLock.release(internalCleanupControl());
    }
  }
}
