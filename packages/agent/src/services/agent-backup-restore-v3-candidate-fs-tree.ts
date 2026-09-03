/** Deterministic tree proof and bounded post-order volatile cleanup. */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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
  candidateFsError,
  candidateFsIdentity,
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

export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS = Object.freeze({
  maximumBytes: 8 * 1024 * 1024 * 1024,
  maximumFiles: 100_000,
  maximumDirectories: 16_384,
  maximumDepth: 32,
  maximumPathBytes: MAX_RELATIVE_PATH_BYTES,
});

export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_CLEANUP_LIMITS = Object.freeze({
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
  if (utilTypes.isProxy(value) || !Array.isArray(value)) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
      "Candidate volatile cleanup requires at most 64 explicit paths",
    );
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > 64) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
      "Candidate volatile cleanup requires at most 64 explicit paths",
    );
  }
  const unique = new Set<string>();
  const names: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_UNSAFE",
        "Candidate volatile cleanup requires dense data-property paths",
      );
    }
    const name = requireControlName(descriptor.value, "volatile path name");
    if (unique.has(name)) {
      candidateFsError(
        "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_UNSAFE",
        "Candidate volatile cleanup contains a duplicate path",
      );
    }
    unique.add(name);
    names.push(name);
  }
  return Object.freeze(names);
}

function updateUint64(
  hash: ReturnType<typeof createHash>,
  value: number,
): void {
  const framed = Buffer.alloc(8);
  framed.writeBigUInt64BE(BigInt(value));
  hash.update(framed);
  framed.fill(0);
}

function updateTreeHeader(
  hash: ReturnType<typeof createHash>,
  kind: "directory" | "file",
  relativePath: string,
  mode: number,
  size: number,
): void {
  const encodedPath = Buffer.from(relativePath, "utf8");
  hash.update(kind === "directory" ? Uint8Array.of(0x44) : Uint8Array.of(0x46));
  updateUint64(hash, encodedPath.byteLength);
  hash.update(encodedPath);
  updateUint64(hash, mode & 0o777);
  updateUint64(hash, size);
}

function compareNames(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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
      const rawName = entry instanceof Uint8Array ? entry : entry.name;
      if (!(rawName instanceof Uint8Array)) {
        candidateFsError(unsafeCode, unsafeMessage);
      }
      const encodedName = Buffer.from(
        rawName.buffer,
        rawName.byteOffset,
        rawName.byteLength,
      );
      const name = encodedName.toString("utf8");
      if (!Buffer.from(name, "utf8").equals(encodedName)) {
        candidateFsError(unsafeCode, unsafeMessage);
      }
      requirePathSegment(name, "candidate directory entry name");
      names.push(name);
    }
  } finally {
    await boundedInternalCleanup(() => directory.close());
  }
  return names.sort(compareNames);
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
      ? Object.freeze({})
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
  return Object.freeze({
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
      ? Object.freeze({})
      : snapshotOwnDataRecord(
          value,
          ["maximumBytes", "maximumEntries", "maximumDepth"],
          [],
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_LIMIT_INVALID",
          "Candidate cleanup limits must be exact data properties",
        );
  return Object.freeze({
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
  const segments = requireRelativePath(
    relativeDirectory,
    "tree directory",
  ).split(path.sep);
  await authority.assertAuthority(control);
  const operationLock = await authority.operationLock(
    `.tree-${createHash("sha256")
      .update(relativeDirectory)
      .digest("hex")
      .slice(0, 16)}`,
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
    const hash = createHash("sha256");
    hash.update(TREE_PROOF_DERIVATION, "utf8");
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
        if (
          Buffer.byteLength(childRelative, "utf8") > limits.maximumPathBytes
        ) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_LIMIT",
            "Candidate tree path exceeds its byte bound",
          );
        }
        const childPath = path.join(anchor, name);
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
            const childTestPath = path.join(testPath, name);
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
          const chunk = new Uint8Array(
            Math.min(CANDIDATE_FS_IO_CHUNK_BYTES, Math.max(1, opened.size)),
          );
          let position = 0;
          try {
            while (position < opened.size) {
              const requested = Math.min(
                chunk.byteLength,
                opened.size - position,
              );
              const read = await controlled(
                () => fileHandle.read(chunk, 0, requested, position),
                control,
              );
              if (read.bytesRead <= 0) {
                candidateFsError(
                  "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_TREE_CHANGED",
                  "Candidate tree file ended while it was proved",
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
      if (
        firstNames.length !== secondNames.length ||
        firstNames.some((name, index) => name !== secondNames[index]) ||
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
    return Object.freeze({
      derivation: TREE_PROOF_DERIVATION,
      ...candidateFsIdentity(finalRoot),
      sha256: hash.digest("hex"),
      bytes,
      files,
      directories,
    });
  } finally {
    const cleanupOperations: Array<() => Promise<void>> = [];
    const handleToClose = rootHandle;
    if (handleToClose) {
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
      const target = path.join(parentAnchor, name);
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
          const testPath = path.join(parentTestPath, name);
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
          entries.push({
            segments,
            parentStats,
            kind: "directory",
            stats: opened,
          });
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
        entries.push({ segments, parentStats, kind: "file", stats });
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
        const target = path.join(root.anchor, name);
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
        entry.segments.slice(0, -1),
        cleanupControl,
      );
      try {
        if (!sameIdentity(parent.stats, entry.parentStats)) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_CHANGED",
            "Candidate volatile parent directory changed before removal",
          );
        }
        const target = path.join(
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
    return Object.freeze({
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
