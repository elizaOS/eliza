/** Deterministic tree proof and bounded post-order volatile cleanup. */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
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
  sameIdentity,
  sameStableFile,
  syncDirectory,
} from "./agent-backup-restore-v3-candidate-fs-control";

const MAX_RELATIVE_PATH_BYTES = 1_024;
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

function resolveTreeLimits(
  value: Partial<AgentBackupRestoreV3CandidateTreeLimits> | undefined,
): Readonly<AgentBackupRestoreV3CandidateTreeLimits> {
  return Object.freeze({
    maximumBytes: requirePositiveSafeInteger(
      value?.maximumBytes ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS.maximumBytes,
      "maximumBytes",
    ),
    maximumFiles: requirePositiveSafeInteger(
      value?.maximumFiles ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS.maximumFiles,
      "maximumFiles",
    ),
    maximumDirectories: requirePositiveSafeInteger(
      value?.maximumDirectories ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS.maximumDirectories,
      "maximumDirectories",
    ),
    maximumDepth: requirePositiveSafeInteger(
      value?.maximumDepth ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS.maximumDepth,
      "maximumDepth",
    ),
    maximumPathBytes: requirePositiveSafeInteger(
      value?.maximumPathBytes ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_TREE_LIMITS.maximumPathBytes,
      "maximumPathBytes",
    ),
  });
}

function resolveCleanupLimits(
  value: Partial<AgentBackupRestoreV3CandidateCleanupLimits> | undefined,
): Readonly<AgentBackupRestoreV3CandidateCleanupLimits> {
  return Object.freeze({
    maximumBytes: requirePositiveSafeInteger(
      value?.maximumBytes ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_CLEANUP_LIMITS.maximumBytes,
      "maximumBytes",
    ),
    maximumEntries: requirePositiveSafeInteger(
      value?.maximumEntries ??
        AGENT_BACKUP_RESTORE_V3_CANDIDATE_CLEANUP_LIMITS.maximumEntries,
      "maximumEntries",
    ),
    maximumDepth: requirePositiveSafeInteger(
      value?.maximumDepth ??
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
  try {
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
      const firstNames = (
        await controlled(() => fs.readdir(anchor), control)
      ).sort(compareNames);
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
      const secondNames = (
        await controlled(() => fs.readdir(anchor), control)
      ).sort(compareNames);
      const afterDirectory = await controlled(
        () => fileStatExact(handle),
        control,
      );
      if (
        firstNames.length !== secondNames.length ||
        firstNames.some((name, index) => name !== secondNames[index]) ||
        !sameIdentity(afterDirectory, expectedDirectory) ||
        afterDirectory.mode !== expectedDirectory.mode ||
        afterDirectory.modifiedNanoseconds !==
          expectedDirectory.modifiedNanoseconds
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
    if (!sameIdentity(finalRoot, root.stats)) {
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
    const handleToClose = rootHandle;
    if (handleToClose) {
      await boundedInternalCleanup(() => handleToClose.close());
    }
    if (operationLock) {
      await operationLock.release(internalCleanupControl());
    }
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
  if (!Array.isArray(names) || names.length > 64) {
    candidateFsError(
      "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
      "Candidate volatile cleanup requires at most 64 explicit paths",
    );
  }
  const unique = new Set<string>();
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
  try {
    const scan = async (
      parentAnchor: string,
      parentTestPath: string,
      parentSegments: readonly string[],
      parentStats: CandidateFsExactStats,
      name: string,
      depth: number,
    ): Promise<void> => {
      if (depth > limits.maximumDepth) {
        candidateFsError(
          "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_LIMIT",
          "Candidate volatile cleanup exceeds its depth bound",
        );
      }
      requirePathSegment(name, "volatile path segment");
      const target = path.join(parentAnchor, name);
      const stats = await controlled(() => lstatExact(target), control);
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
          const children = (
            await controlled(() => fs.readdir(anchor), control)
          ).sort(compareNames);
          for (const child of children) {
            await scan(anchor, testPath, segments, opened, child, depth + 1);
          }
          const after = await controlled(
            () => fileStatExact(directoryHandle),
            control,
          );
          if (!sameIdentity(after, opened)) {
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
      for (const rawName of names) {
        const name = requireControlName(rawName, "volatile path name");
        if (unique.has(name)) {
          candidateFsError(
            "AGENT_BACKUP_RESTORE_V3_CANDIDATE_FS_CLEANUP_UNSAFE",
            "Candidate volatile cleanup contains a duplicate path",
          );
        }
        unique.add(name);
        try {
          await scan(root.anchor, root.testPath, [], root.stats, name, 0);
        } catch (cause) {
          if (!isErrno(cause, "ENOENT")) throw cause;
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
    if (operationLock) {
      await operationLock.release(internalCleanupControl());
    }
  }
}
