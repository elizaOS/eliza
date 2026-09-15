/**
 * Sandboxed per-project filesystem rooted at
 * `${STATE_DIR}/agent-vfs/projects/<projectId>/files`. VirtualFilesystemService
 * exposes read/write/list/delete plus snapshot/diff/rollback and quota
 * accounting, mapping caller-facing virtual paths onto disk while enforcing the
 * sandbox: project-id sanitization, per-path traversal rejection, symlink denial
 * on every access, a per-file byte cap, and a total-project quota. Backs the VFS
 * builtin shell and git services and the workbench routes.
 *
 * The `projectId` here is a workbench-sandbox namespace, deliberately SEPARATE
 * from the Project entity in the core project registry (`project-registry.ts`,
 * #13776): that one binds a task to a real local repo path, this one names an
 * isolated scratch tree. They are not reconciled and must not be conflated.
 */
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ElizaError, type ElizaErrorOptions, logger } from "@elizaos/core";
import { writeJsonAtomic } from "@elizaos/core/atomic-json";
import { resolveStateDir } from "../config/paths.ts";

const DEFAULT_QUOTA_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const projectOperations = new Map<string, Promise<void>>();

export type VirtualFilesystemDiffStatus = "added" | "modified" | "deleted";

export interface VirtualFilesystemOptions {
  stateDir?: string;
  projectId: string;
  quotaBytes?: number;
  maxFileBytes?: number;
  now?: () => Date;
}

export interface VirtualFilesystemEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  mtimeMs: number;
}

export interface VirtualFilesystemSnapshot {
  id: string;
  projectId: string;
  createdAt: string;
  root: string;
  filesBytes: number;
  fileCount: number;
  note?: string;
}

export interface VirtualFilesystemRollback {
  snapshotId: string;
  projectId: string;
  rolledBackAt: string;
  previousSnapshotId?: string;
}

export interface VirtualFilesystemDiffEntry {
  path: string;
  status: VirtualFilesystemDiffStatus;
  before?: VirtualFilesystemEntry;
  after?: VirtualFilesystemEntry;
}

export interface VirtualFilesystemQuota {
  usedBytes: number;
  fileCount: number;
  quotaBytes: number;
  maxFileBytes: number;
}

export interface VirtualFilesystemExportFile extends VirtualFilesystemEntry {
  bytes: Buffer;
}

interface TreeStats {
  bytes: number;
  fileCount: number;
}

interface IndexedEntry extends VirtualFilesystemEntry {
  hash?: string;
}

interface PendingRollback {
  version: 1;
  stageName: string;
  backupName: string;
  rollback: VirtualFilesystemRollback;
}

export class VirtualFilesystemError extends ElizaError {
  override readonly name = "VirtualFilesystemError";
  constructor(
    message: string,
    override readonly code:
      | "PATH_TRAVERSAL"
      | "INVALID_PATH"
      | "NOT_FOUND"
      | "NOT_FILE"
      | "NOT_DIRECTORY"
      | "SYMLINK_DENIED"
      | "QUOTA_EXCEEDED"
      | "SNAPSHOT_NOT_FOUND"
      | "INVALID_SNAPSHOT"
      | "VFS_STORAGE_FAILED"
      | "ROLLBACK_FAILED"
      | "ROLLBACK_RECOVERY_FAILED",
    options: Omit<ElizaErrorOptions, "code"> = {},
  ) {
    super(message, { ...options, code });
  }
}

export class VirtualFilesystemService {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly filesRoot: string;
  readonly snapshotsRoot: string;
  readonly quotaBytes: number;
  readonly maxFileBytes: number;
  private readonly now: () => Date;

  constructor(options: VirtualFilesystemOptions) {
    this.projectId = sanitizeProjectId(options.projectId);
    const stateDir =
      options.stateDir ?? resolveStateDir(process.env, os.homedir);
    this.projectRoot = path.join(
      stateDir,
      "agent-vfs",
      "projects",
      this.projectId,
    );
    this.filesRoot = path.join(this.projectRoot, "files");
    this.snapshotsRoot = path.join(this.projectRoot, "snapshots");
    this.quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.withStorageOperation(async () => {});
  }

  /**
   * Serialize an operation against this project's files, including direct Git
   * writes. The callback must use disk operations, not re-enter public VFS
   * methods. Pending restores are recovered before the callback can see files.
   * This coordinates service instances within the host process.
   */
  async withProjectOperation<T>(operation: () => Promise<T>): Promise<T> {
    const key = path.resolve(this.projectRoot);
    const previous = projectOperations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    projectOperations.set(key, queued);
    await previous;
    try {
      await this.recoverPendingRollback();
      await fsp.mkdir(this.filesRoot, { recursive: true, mode: 0o700 });
      await fsp.mkdir(this.snapshotsRoot, { recursive: true, mode: 0o700 });
      await this.assertDirectory(this.filesRoot);
      const snapshots = await fsp.lstat(this.snapshotsRoot);
      if (snapshots.isSymbolicLink()) {
        throw new VirtualFilesystemError(
          "Invalid snapshot storage directory",
          "INVALID_SNAPSHOT",
        );
      }
      return await operation();
    } finally {
      release();
      if (projectOperations.get(key) === queued) projectOperations.delete(key);
    }
  }

  private async withStorageOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.withProjectOperation(operation);
    } catch (cause) {
      // error-policy:J2 The service preserves domain failures and wraps disk
      // failures so routes distinguish unavailable storage from invalid input.
      if (cause instanceof ElizaError) throw cause;
      throw new VirtualFilesystemError(
        "VFS storage operation failed",
        "VFS_STORAGE_FAILED",
        {
          cause,
          context: { projectId: this.projectId },
        },
      );
    }
  }

  async writeFile(
    virtualPath: string,
    contents: string | Uint8Array,
  ): Promise<VirtualFilesystemEntry> {
    return this.withStorageOperation(async () => {
      const data = Buffer.from(contents);
      if (data.byteLength > this.maxFileBytes) {
        throw new VirtualFilesystemError(
          `File exceeds max file size of ${this.maxFileBytes} bytes`,
          "QUOTA_EXCEEDED",
        );
      }
      const target = this.resolvePath(virtualPath);
      await this.ensureSafeParentDirectory(target);
      await this.rejectSymlinkIfExists(target);
      const existingSize = await this.fileSizeIfExists(target);
      const current = await this.measureFiles();
      const nextBytes = current.bytes - existingSize + data.byteLength;
      if (nextBytes > this.quotaBytes) {
        throw new VirtualFilesystemError(
          `Project quota exceeded: ${nextBytes}/${this.quotaBytes} bytes`,
          "QUOTA_EXCEEDED",
        );
      }
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.writeFile(target, data, { mode: 0o600 });
      return this.entryFor(target);
    });
  }

  async mkdir(
    virtualPath: string,
    options: { recursive?: boolean } = {},
  ): Promise<void> {
    return this.withStorageOperation(async () => {
      const target = this.resolvePath(virtualPath);
      await this.ensureSafeParentDirectory(target);
      await this.rejectSymlinkIfExists(target);
      await fsp.mkdir(target, {
        recursive: Boolean(options.recursive),
        mode: 0o700,
      });
    });
  }

  async readFile(
    virtualPath: string,
    encoding: BufferEncoding = "utf-8",
  ): Promise<string> {
    return this.withStorageOperation(async () => {
      const target = this.resolvePath(virtualPath);
      await this.assertFile(target);
      return fsp.readFile(target, encoding);
    });
  }

  async readFileBytes(virtualPath: string): Promise<Buffer> {
    return this.withStorageOperation(async () => {
      const target = this.resolvePath(virtualPath);
      await this.assertFile(target);
      return fsp.readFile(target);
    });
  }

  async list(
    virtualPath = ".",
    options: { recursive?: boolean } = {},
  ): Promise<VirtualFilesystemEntry[]> {
    return this.withStorageOperation(async () => {
      const target = this.resolvePath(virtualPath);
      await this.assertDirectory(target);
      const entries = await this.listEntries(
        target,
        Boolean(options.recursive),
      );
      return entries.sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  async delete(
    virtualPath: string,
    options: { recursive?: boolean } = {},
  ): Promise<void> {
    return this.withStorageOperation(async () => {
      const target = this.resolvePath(virtualPath);
      await this.ensureSafeParentDirectory(target);
      await this.rejectSymlinkIfExists(target);
      try {
        await fsp.rm(target, {
          recursive: Boolean(options.recursive),
          force: false,
        });
      } catch (error) {
        // error-policy:J2 Preserve missing-path classification and disk failures.
        if (isNodeErrno(error, "ENOENT")) {
          throw new VirtualFilesystemError("Path not found", "NOT_FOUND");
        }
        throw error;
      }
    });
  }

  async createSnapshot(note?: string): Promise<VirtualFilesystemSnapshot> {
    return this.withStorageOperation(() => this.createSnapshotUnlocked(note));
  }

  private async createSnapshotUnlocked(
    note?: string,
  ): Promise<VirtualFilesystemSnapshot> {
    const id = snapshotId(this.now());
    const snapshotDir = path.join(this.snapshotsRoot, id);
    const stage = await fsp.mkdtemp(path.join(this.projectRoot, ".snapshot-"));
    try {
      const stagedFiles = path.join(stage, "files");
      await fsp.cp(this.filesRoot, stagedFiles, {
        recursive: true,
        dereference: false,
      });
      const stats = await this.measureTree(stagedFiles);
      const snapshot: VirtualFilesystemSnapshot = {
        id,
        projectId: this.projectId,
        createdAt: this.now().toISOString(),
        root: path.join(snapshotDir, "files"),
        filesBytes: stats.bytes,
        fileCount: stats.fileCount,
        ...(note !== undefined ? { note } : {}),
      };
      await writeJsonAtomic(path.join(stage, "snapshot.json"), snapshot);
      await fsp.rename(stage, snapshotDir);
      return snapshot;
    } finally {
      await this.cleanupStaging(stage);
    }
  }

  async getSnapshot(id: string): Promise<VirtualFilesystemSnapshot> {
    return this.withStorageOperation(() => this.readSnapshot(id));
  }

  async listSnapshots(): Promise<VirtualFilesystemSnapshot[]> {
    return this.withStorageOperation(async () => {
      const entries = await fsp.readdir(this.snapshotsRoot, {
        withFileTypes: true,
      });
      const snapshots: VirtualFilesystemSnapshot[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const snapshot = await this.readSnapshot(entry.name);
        snapshots.push(snapshot);
      }
      return snapshots.sort((a, b) => {
        const aTime = Date.parse(a.createdAt);
        const bTime = Date.parse(b.createdAt);
        if (bTime !== aTime) return bTime - aTime;
        return a.id.localeCompare(b.id);
      });
    });
  }

  async diffSnapshots(
    beforeSnapshotId: string,
    afterSnapshotId: string,
  ): Promise<VirtualFilesystemDiffEntry[]> {
    return this.withStorageOperation(async () => {
      const before = await this.snapshotFilesRoot(beforeSnapshotId);
      const after = await this.snapshotFilesRoot(afterSnapshotId);
      const beforeIndex = await this.indexTree(before);
      const afterIndex = await this.indexTree(after);
      return diffIndexes(beforeIndex, afterIndex);
    });
  }

  async diffCurrent(snapshotId: string): Promise<VirtualFilesystemDiffEntry[]> {
    return this.withStorageOperation(async () => {
      const before = await this.snapshotFilesRoot(snapshotId);
      const beforeIndex = await this.indexTree(before);
      const afterIndex = await this.indexTree(this.filesRoot);
      return diffIndexes(beforeIndex, afterIndex);
    });
  }

  async rollback(snapshotId: string): Promise<VirtualFilesystemRollback> {
    return this.withStorageOperation(async () => {
      const snapshot = await this.readSnapshot(snapshotId);
      const source = await this.snapshotFilesRoot(snapshotId);
      await this.validateSnapshotTree(snapshot, source);
      const stageName = `.rollback-stage-${crypto.randomUUID()}`;
      const backupName = `.rollback-backup-${crypto.randomUUID()}`;
      const stage = path.join(this.projectRoot, stageName);
      let pending: PendingRollback | undefined;
      let journalWritten = false;
      let committed = false;
      try {
        await fsp.cp(source, stage, { recursive: true, dereference: false });
        await this.validateSnapshotTree(snapshot, stage);
        const previous = await this.createSnapshotUnlocked(
          `pre-rollback:${snapshotId}`,
        );
        const rollback: VirtualFilesystemRollback = {
          snapshotId,
          projectId: this.projectId,
          rolledBackAt: this.now().toISOString(),
          previousSnapshotId: previous.id,
        };
        pending = { version: 1, stageName, backupName, rollback };
        await writeJsonAtomic(this.pendingRollbackPath, pending);
        journalWritten = true;
        await fsp.rename(
          this.filesRoot,
          path.join(this.projectRoot, backupName),
        );
        await fsp.rename(stage, this.filesRoot);
        // This atomic metadata write is the commit marker. Until it succeeds,
        // recovery restores the previous directory after any interruption.
        await writeJsonAtomic(
          path.join(this.projectRoot, "last-rollback.json"),
          rollback,
        );
        committed = true;
        await this.recoverPendingRollback(true);
        return rollback;
      } catch (cause) {
        // error-policy:J2 Failed restores retain the original live tree. If
        // recovery also fails, retain the journal and both causes for retry.
        if (journalWritten) {
          try {
            await this.recoverPendingRollback(committed);
          } catch (recoveryCause) {
            // error-policy:J2 Recovery failure keeps durable evidence intact.
            throw new VirtualFilesystemError(
              "VFS rollback recovery failed; retry initialization after repairing storage",
              "ROLLBACK_RECOVERY_FAILED",
              {
                cause: new AggregateError([cause, recoveryCause]),
                context: { projectId: this.projectId, snapshotId, committed },
                severity: "fatal",
              },
            );
          }
          if (committed && pending) return pending.rollback;
        } else {
          await this.cleanupStaging(stage);
        }
        throw new VirtualFilesystemError(
          "VFS rollback failed; the previous workspace is preserved",
          "ROLLBACK_FAILED",
          {
            cause,
            context: { projectId: this.projectId, snapshotId },
          },
        );
      }
    });
  }

  private get pendingRollbackPath(): string {
    return path.join(this.projectRoot, ".pending-rollback.json");
  }

  private async recoverPendingRollback(
    knownCommitted?: boolean,
  ): Promise<void> {
    const raw = await readJsonFile(this.pendingRollbackPath);
    if (raw === undefined) return;
    const pending = parsePendingRollback(raw, this.projectId);
    const stage = path.join(this.projectRoot, pending.stageName);
    const backup = path.join(this.projectRoot, pending.backupName);
    const committed =
      knownCommitted ??
      rollbackMatches(
        await readJsonFile(path.join(this.projectRoot, "last-rollback.json")),
        pending.rollback,
      );
    const previous = await lstatOrNull(backup);
    if (previous && (!previous.isDirectory() || previous.isSymbolicLink())) {
      throw new VirtualFilesystemError(
        "Invalid VFS rollback backup directory",
        "ROLLBACK_RECOVERY_FAILED",
        { severity: "fatal" },
      );
    }
    if (committed) {
      await this.assertDirectory(this.filesRoot);
      await fsp.rm(backup, { recursive: true, force: true });
    } else if (previous) {
      await fsp.rm(stage, { recursive: true, force: true });
      if (await lstatOrNull(this.filesRoot))
        await fsp.rename(this.filesRoot, stage);
      await fsp.rename(backup, this.filesRoot);
    } else {
      // Before the first rename, the live directory is still the original.
      // Do not manufacture an empty tree if recovery evidence is incomplete.
      await this.assertDirectory(this.filesRoot);
    }
    await fsp.rm(stage, { recursive: true, force: true });
    await fsp.rm(this.pendingRollbackPath);
  }

  private async cleanupStaging(stage: string): Promise<void> {
    try {
      await fsp.rm(stage, { recursive: true, force: true });
    } catch (error) {
      // error-policy:J6 An unpublished staging directory is teardown-only;
      // leave it for inspection without replacing the primary operation error.
      logger.warn(
        { projectId: this.projectId, stage, error },
        "[VirtualFilesystem] Failed to remove staging directory",
      );
    }
  }

  private async validateSnapshotTree(
    snapshot: VirtualFilesystemSnapshot,
    root: string,
  ): Promise<void> {
    const stats = await this.measureTree(root, true);
    if (
      stats.bytes !== snapshot.filesBytes ||
      stats.fileCount !== snapshot.fileCount
    ) {
      throw new VirtualFilesystemError(
        "Snapshot files do not match saved metadata",
        "INVALID_SNAPSHOT",
        {
          context: { projectId: this.projectId, snapshotId: snapshot.id },
        },
      );
    }
    if (stats.bytes > this.quotaBytes) {
      throw new VirtualFilesystemError(
        "Snapshot exceeds the current project quota",
        "QUOTA_EXCEEDED",
      );
    }
  }

  async quota(): Promise<VirtualFilesystemQuota> {
    return this.withStorageOperation(async () => {
      const stats = await this.measureFiles();
      return {
        usedBytes: stats.bytes,
        fileCount: stats.fileCount,
        quotaBytes: this.quotaBytes,
        maxFileBytes: this.maxFileBytes,
      };
    });
  }

  resolveVirtualPath(virtualPath: string): string {
    return toVirtualPath(this.resolvePath(virtualPath), this.filesRoot);
  }

  /**
   * Resolve a virtual path to its absolute on-disk location, applying the same
   * traversal/symlink rules used by readFile/writeFile. The returned path is
   * always inside the project's `filesRoot` and is the path Node/Bun will use
   * if you `pathToFileURL()` it for a dynamic import. The path is not required
   * to exist — callers that need existence should `readFile` it first.
   */
  resolveDiskPath(virtualPath: string): string {
    return this.resolvePath(virtualPath);
  }

  async exportFiles(
    snapshotId?: string,
  ): Promise<VirtualFilesystemExportFile[]> {
    return this.withStorageOperation(async () => {
      const root = snapshotId
        ? await this.snapshotFilesRoot(snapshotId)
        : this.filesRoot;
      const files: VirtualFilesystemExportFile[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const dirent of await fsp.readdir(dir, { withFileTypes: true })) {
          const realPath = path.join(dir, dirent.name);
          if (dirent.isSymbolicLink()) {
            throw new VirtualFilesystemError(
              "Symlinks are not allowed in the VFS",
              "SYMLINK_DENIED",
            );
          }
          if (dirent.isDirectory()) {
            await walk(realPath);
            continue;
          }
          if (!dirent.isFile()) continue;
          const stat = await fsp.lstat(realPath);
          const bytes = await fsp.readFile(realPath);
          files.push({
            path: toVirtualPath(realPath, root),
            type: "file",
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            bytes,
          });
        }
      };
      await walk(root);
      return files.sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  private resolvePath(virtualPath: string): string {
    const normalized = normalizeVirtualPath(virtualPath);
    const resolved = path.resolve(this.filesRoot, normalized);
    if (!isWithin(this.filesRoot, resolved)) {
      throw new VirtualFilesystemError(
        "Path escapes virtual filesystem root",
        "PATH_TRAVERSAL",
      );
    }
    return resolved;
  }

  private async ensureSafeParentDirectory(target: string): Promise<void> {
    const relativeParent = path.relative(this.filesRoot, path.dirname(target));
    if (!relativeParent) return;

    let current = this.filesRoot;
    for (const segment of relativeParent.split(path.sep)) {
      current = path.join(current, segment);
      const stat = await lstatOrNull(current);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        throw new VirtualFilesystemError(
          `Symlink path component denied: ${toVirtualPath(current, this.filesRoot)}`,
          "SYMLINK_DENIED",
        );
      }
      if (!stat.isDirectory()) {
        throw new VirtualFilesystemError(
          "Parent path is not a directory",
          "NOT_DIRECTORY",
        );
      }
    }
  }

  private async rejectSymlinkIfExists(target: string): Promise<void> {
    const stat = await lstatOrNull(target);
    if (stat?.isSymbolicLink()) {
      throw new VirtualFilesystemError(
        "Symlinks are not allowed in the VFS",
        "SYMLINK_DENIED",
      );
    }
  }

  private async assertFile(target: string): Promise<void> {
    await this.ensureSafeParentDirectory(target);
    const stat = await lstatOrNull(target);
    if (!stat) {
      throw new VirtualFilesystemError("File not found", "NOT_FOUND");
    }
    if (stat.isSymbolicLink()) {
      throw new VirtualFilesystemError(
        "Symlinks are not allowed in the VFS",
        "SYMLINK_DENIED",
      );
    }
    if (!stat.isFile()) {
      throw new VirtualFilesystemError("Path is not a file", "NOT_FILE");
    }
  }

  private async assertDirectory(target: string): Promise<void> {
    await this.ensureSafeParentDirectory(target);
    const stat = await lstatOrNull(target);
    if (!stat) {
      throw new VirtualFilesystemError("Directory not found", "NOT_FOUND");
    }
    if (stat.isSymbolicLink()) {
      throw new VirtualFilesystemError(
        "Symlinks are not allowed in the VFS",
        "SYMLINK_DENIED",
      );
    }
    if (!stat.isDirectory()) {
      throw new VirtualFilesystemError(
        "Path is not a directory",
        "NOT_DIRECTORY",
      );
    }
  }

  private async entryFor(realPath: string): Promise<VirtualFilesystemEntry> {
    const stat = await fsp.lstat(realPath);
    return {
      path: toVirtualPath(realPath, this.filesRoot),
      type: stat.isDirectory() ? "directory" : "file",
      size: stat.isFile() ? stat.size : 0,
      mtimeMs: stat.mtimeMs,
    };
  }

  private async listEntries(
    realDir: string,
    recursive: boolean,
  ): Promise<VirtualFilesystemEntry[]> {
    const dirents = await fsp.readdir(realDir, { withFileTypes: true });
    const entries: VirtualFilesystemEntry[] = [];
    for (const dirent of dirents) {
      const realPath = path.join(realDir, dirent.name);
      if (dirent.isSymbolicLink()) {
        throw new VirtualFilesystemError(
          "Symlinks are not allowed in the VFS",
          "SYMLINK_DENIED",
        );
      }
      const entry = await this.entryFor(realPath);
      entries.push(entry);
      if (recursive && dirent.isDirectory()) {
        entries.push(...(await this.listEntries(realPath, true)));
      }
    }
    return entries;
  }

  private async measureFiles(): Promise<TreeStats> {
    return this.measureTree(this.filesRoot);
  }

  private async measureTree(
    root: string,
    enforceFileLimit = false,
  ): Promise<TreeStats> {
    const stat = await lstatOrNull(root);
    if (!stat)
      throw new VirtualFilesystemError("VFS tree is missing", "NOT_FOUND");
    if (stat.isSymbolicLink()) {
      throw new VirtualFilesystemError(
        "Symlinks are not allowed in the VFS",
        "SYMLINK_DENIED",
      );
    }
    if (stat.isFile()) {
      if (enforceFileLimit && stat.size > this.maxFileBytes) {
        throw new VirtualFilesystemError(
          "Snapshot file exceeds the current file size limit",
          "QUOTA_EXCEEDED",
        );
      }
      return { bytes: stat.size, fileCount: 1 };
    }
    if (!stat.isDirectory()) {
      throw new VirtualFilesystemError(
        "Unsupported file type in VFS tree",
        "NOT_FILE",
      );
    }

    let bytes = 0;
    let fileCount = 0;
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      const child = path.join(root, entry.name);
      const stats = await this.measureTree(child, enforceFileLimit);
      bytes += stats.bytes;
      fileCount += stats.fileCount;
    }
    return { bytes, fileCount };
  }

  private async fileSizeIfExists(realPath: string): Promise<number> {
    const stat = await lstatOrNull(realPath);
    if (!stat) return 0;
    if (stat.isSymbolicLink()) {
      throw new VirtualFilesystemError(
        "Symlinks are not allowed in the VFS",
        "SYMLINK_DENIED",
      );
    }
    if (!stat.isFile()) {
      throw new VirtualFilesystemError("Path is not a file", "NOT_FILE");
    }
    return stat.size;
  }

  private async readSnapshot(id: string): Promise<VirtualFilesystemSnapshot> {
    const normalizedId = normalizeSnapshotId(id);
    const snapshotDir = path.join(this.snapshotsRoot, normalizedId);
    const directory = await lstatOrNull(snapshotDir);
    if (!directory) {
      throw new VirtualFilesystemError(
        `Snapshot not found: ${id}`,
        "SNAPSHOT_NOT_FOUND",
      );
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new VirtualFilesystemError(
        "Invalid saved snapshot directory",
        "INVALID_SNAPSHOT",
      );
    }
    const raw = await readJsonFile(path.join(snapshotDir, "snapshot.json"));
    if (
      !isRecord(raw) ||
      raw.id !== normalizedId ||
      raw.projectId !== this.projectId ||
      !isTimestamp(raw.createdAt) ||
      typeof raw.root !== "string" ||
      !raw.root ||
      !isNonnegativeInteger(raw.filesBytes) ||
      !isNonnegativeInteger(raw.fileCount) ||
      (raw.note !== undefined && typeof raw.note !== "string")
    ) {
      throw new VirtualFilesystemError(
        "Invalid saved snapshot metadata",
        "INVALID_SNAPSHOT",
        {
          context: { projectId: this.projectId, snapshotId: normalizedId },
        },
      );
    }
    return {
      id: normalizedId,
      projectId: this.projectId,
      createdAt: raw.createdAt,
      root: path.join(this.snapshotsRoot, normalizedId, "files"),
      filesBytes: raw.filesBytes,
      fileCount: raw.fileCount,
      ...(raw.note !== undefined ? { note: raw.note } : {}),
    };
  }

  private async snapshotFilesRoot(id: string): Promise<string> {
    const snapshot = await this.readSnapshot(id);
    const root = path.join(this.snapshotsRoot, snapshot.id, "files");
    const stat = await lstatOrNull(root);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new VirtualFilesystemError(
        "Snapshot files are unavailable",
        "INVALID_SNAPSHOT",
        {
          context: { projectId: this.projectId, snapshotId: snapshot.id },
        },
      );
    }
    return root;
  }

  private async indexTree(root: string): Promise<Map<string, IndexedEntry>> {
    const index = new Map<string, IndexedEntry>();
    const walk = async (dir: string): Promise<void> => {
      for (const dirent of await fsp.readdir(dir, { withFileTypes: true })) {
        const realPath = path.join(dir, dirent.name);
        if (dirent.isSymbolicLink()) {
          throw new VirtualFilesystemError(
            "Symlinks are not allowed in the VFS",
            "SYMLINK_DENIED",
          );
        }
        const stat = await fsp.lstat(realPath);
        const entry: IndexedEntry = {
          path: toVirtualPath(realPath, root),
          type: stat.isDirectory() ? "directory" : "file",
          size: stat.isFile() ? stat.size : 0,
          mtimeMs: stat.mtimeMs,
          ...(stat.isFile() ? { hash: await sha256(realPath) } : {}),
        };
        index.set(entry.path, entry);
        if (dirent.isDirectory()) {
          await walk(realPath);
        }
      }
    };
    await walk(root);
    return index;
  }
}

export function createVirtualFilesystemService(
  options: VirtualFilesystemOptions,
): VirtualFilesystemService {
  return new VirtualFilesystemService(options);
}

function sanitizeProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.length > 120 ||
    !/^[a-zA-Z0-9._-]+$/.test(normalized)
  ) {
    throw new VirtualFilesystemError("Invalid VFS project id", "INVALID_PATH");
  }
  return normalized;
}

function normalizeVirtualPath(input: string): string {
  if (typeof input !== "string" || input.includes("\0")) {
    throw new VirtualFilesystemError("Invalid virtual path", "INVALID_PATH");
  }
  const value = input.trim().replace(/\\/g, "/");
  if (!value || value === "." || value === "/") {
    return ".";
  }
  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new VirtualFilesystemError(
      "Path traversal segments are not allowed",
      "PATH_TRAVERSAL",
    );
  }
  return segments.join(path.sep);
}

function normalizeSnapshotId(id: string): string {
  if (id === "." || id === ".." || !/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new VirtualFilesystemError("Invalid snapshot id", "INVALID_PATH");
  }
  return id;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function toVirtualPath(realPath: string, root: string): string {
  const relative = path.relative(root, realPath).replace(/\\/g, "/");
  return relative ? `/${relative}` : "/";
}

async function lstatOrNull(realPath: string) {
  try {
    return await fsp.lstat(realPath);
  } catch (error) {
    // error-policy:J4 Only an absent path is an expected unavailable result.
    if (isNodeErrno(error, "ENOENT")) return null;
    throw error;
  }
}

function snapshotId(now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sha256(realPath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  hash.update(await fsp.readFile(realPath));
  return hash.digest("hex");
}

function isNodeErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function diffIndexes(
  before: Map<string, IndexedEntry>,
  after: Map<string, IndexedEntry>,
): VirtualFilesystemDiffEntry[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  const diff: VirtualFilesystemDiffEntry[] = [];
  for (const entryPath of [...paths].sort()) {
    const beforeEntry = before.get(entryPath);
    const afterEntry = after.get(entryPath);
    if (!beforeEntry && afterEntry) {
      diff.push({ path: entryPath, status: "added", after: afterEntry });
      continue;
    }
    if (beforeEntry && !afterEntry) {
      diff.push({ path: entryPath, status: "deleted", before: beforeEntry });
      continue;
    }
    if (!beforeEntry || !afterEntry) continue;
    const same =
      beforeEntry.type === afterEntry.type &&
      beforeEntry.size === afterEntry.size &&
      beforeEntry.hash === afterEntry.hash;
    if (!same) {
      diff.push({
        path: entryPath,
        status: "modified",
        before: beforeEntry,
        after: afterEntry,
      });
    }
  }
  return diff;
}

async function readJsonFile(filename: string): Promise<unknown> {
  let raw: string;
  try {
    if ((await fsp.lstat(filename)).isSymbolicLink()) {
      throw new VirtualFilesystemError(
        "Invalid VFS metadata file",
        "INVALID_SNAPSHOT",
      );
    }
    raw = await fsp.readFile(filename, "utf8");
  } catch (cause) {
    // error-policy:J4 Only an absent record is unavailable; other read failures
    // must remain distinct from an empty snapshot collection.
    if (cause instanceof VirtualFilesystemError) throw cause;
    if (isNodeErrno(cause, "ENOENT")) return undefined;
    throw new VirtualFilesystemError(
      "Failed to read VFS metadata",
      "VFS_STORAGE_FAILED",
      {
        cause,
        context: { filename },
      },
    );
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    // error-policy:J3 Malformed persisted JSON is an explicit invalid state.
    throw new VirtualFilesystemError(
      "Invalid VFS metadata JSON",
      "INVALID_SNAPSHOT",
      {
        cause,
        context: { filename },
      },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function rollbackMatches(
  value: unknown,
  expected: VirtualFilesystemRollback,
): boolean {
  if (value === undefined) return false;
  const stored = parseRollback(value, expected.projectId);
  return (
    stored.snapshotId === expected.snapshotId &&
    stored.previousSnapshotId === expected.previousSnapshotId &&
    stored.rolledBackAt === expected.rolledBackAt
  );
}

function parseRollback(
  value: unknown,
  projectId: string,
): VirtualFilesystemRollback {
  if (
    !isRecord(value) ||
    value.projectId !== projectId ||
    typeof value.snapshotId !== "string" ||
    !isTimestamp(value.rolledBackAt) ||
    (value.previousSnapshotId !== undefined &&
      typeof value.previousSnapshotId !== "string")
  ) {
    throw new VirtualFilesystemError(
      "Invalid VFS rollback metadata",
      "ROLLBACK_RECOVERY_FAILED",
      { severity: "fatal" },
    );
  }
  return {
    projectId,
    snapshotId: normalizeSnapshotId(value.snapshotId),
    rolledBackAt: value.rolledBackAt,
    ...(value.previousSnapshotId !== undefined
      ? { previousSnapshotId: normalizeSnapshotId(value.previousSnapshotId) }
      : {}),
  };
}

function parsePendingRollback(
  value: unknown,
  projectId: string,
): PendingRollback {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.stageName !== "string" ||
    !/^\.rollback-stage-[a-f0-9-]{36}$/.test(value.stageName) ||
    typeof value.backupName !== "string" ||
    !/^\.rollback-backup-[a-f0-9-]{36}$/.test(value.backupName) ||
    !isRecord(value.rollback) ||
    typeof value.rollback.previousSnapshotId !== "string"
  ) {
    throw new VirtualFilesystemError(
      "Invalid pending VFS rollback metadata",
      "ROLLBACK_RECOVERY_FAILED",
      { severity: "fatal" },
    );
  }
  const rollback = parseRollback(value.rollback, projectId);
  return {
    version: 1,
    stageName: value.stageName,
    backupName: value.backupName,
    rollback,
  };
}
