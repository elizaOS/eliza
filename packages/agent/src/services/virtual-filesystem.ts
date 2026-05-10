import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.ts";
import { writeJsonAtomic } from "../utils/atomic-json.ts";

const DEFAULT_QUOTA_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

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

interface TreeStats {
  bytes: number;
  fileCount: number;
}

interface IndexedEntry extends VirtualFilesystemEntry {
  hash?: string;
}

export class VirtualFilesystemError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "PATH_TRAVERSAL"
      | "INVALID_PATH"
      | "NOT_FOUND"
      | "NOT_FILE"
      | "NOT_DIRECTORY"
      | "SYMLINK_DENIED"
      | "QUOTA_EXCEEDED"
      | "SNAPSHOT_NOT_FOUND",
  ) {
    super(message);
    this.name = "VirtualFilesystemError";
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
    await fsp.mkdir(this.filesRoot, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.snapshotsRoot, { recursive: true, mode: 0o700 });
  }

  async writeFile(
    virtualPath: string,
    contents: string | Uint8Array,
  ): Promise<VirtualFilesystemEntry> {
    const data =
      typeof contents === "string"
        ? Buffer.from(contents)
        : Buffer.from(contents);
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
  }

  async readFile(
    virtualPath: string,
    encoding: BufferEncoding = "utf-8",
  ): Promise<string> {
    const target = this.resolvePath(virtualPath);
    await this.assertFile(target);
    return fsp.readFile(target, encoding);
  }

  async readFileBytes(virtualPath: string): Promise<Buffer> {
    const target = this.resolvePath(virtualPath);
    await this.assertFile(target);
    return fsp.readFile(target);
  }

  async list(
    virtualPath = ".",
    options: { recursive?: boolean } = {},
  ): Promise<VirtualFilesystemEntry[]> {
    const target = this.resolvePath(virtualPath);
    await this.assertDirectory(target);
    const entries = await this.listEntries(target, Boolean(options.recursive));
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async delete(
    virtualPath: string,
    options: { recursive?: boolean } = {},
  ): Promise<void> {
    const target = this.resolvePath(virtualPath);
    await this.ensureSafeParentDirectory(target);
    await this.rejectSymlinkIfExists(target);
    await fsp.rm(target, {
      recursive: Boolean(options.recursive),
      force: false,
    });
  }

  async createSnapshot(note?: string): Promise<VirtualFilesystemSnapshot> {
    await this.initialize();
    const id = snapshotId(this.now());
    const snapshotDir = path.join(this.snapshotsRoot, id);
    const snapshotFilesRoot = path.join(snapshotDir, "files");
    await fsp.mkdir(snapshotFilesRoot, { recursive: true, mode: 0o700 });
    await fsp.cp(this.filesRoot, snapshotFilesRoot, {
      recursive: true,
      errorOnExist: false,
      force: true,
      dereference: false,
    });

    const stats = await this.measureTree(snapshotFilesRoot);
    const snapshot: VirtualFilesystemSnapshot = {
      id,
      projectId: this.projectId,
      createdAt: this.now().toISOString(),
      root: snapshotFilesRoot,
      filesBytes: stats.bytes,
      fileCount: stats.fileCount,
      ...(note ? { note } : {}),
    };
    await writeJsonAtomic(path.join(snapshotDir, "snapshot.json"), snapshot);
    return snapshot;
  }

  async getSnapshot(id: string): Promise<VirtualFilesystemSnapshot> {
    const snapshot = await this.readSnapshot(id);
    if (!snapshot) {
      throw new VirtualFilesystemError(
        `Snapshot not found: ${id}`,
        "SNAPSHOT_NOT_FOUND",
      );
    }
    return snapshot;
  }

  async diffSnapshots(
    beforeSnapshotId: string,
    afterSnapshotId: string,
  ): Promise<VirtualFilesystemDiffEntry[]> {
    const before = await this.snapshotFilesRoot(beforeSnapshotId);
    const after = await this.snapshotFilesRoot(afterSnapshotId);
    const beforeIndex = await this.indexTree(before);
    const afterIndex = await this.indexTree(after);
    return diffIndexes(beforeIndex, afterIndex);
  }

  async diffCurrent(snapshotId: string): Promise<VirtualFilesystemDiffEntry[]> {
    const before = await this.snapshotFilesRoot(snapshotId);
    const beforeIndex = await this.indexTree(before);
    const afterIndex = await this.indexTree(this.filesRoot);
    return diffIndexes(beforeIndex, afterIndex);
  }

  async rollback(snapshotId: string): Promise<VirtualFilesystemRollback> {
    const snapshotRoot = await this.snapshotFilesRoot(snapshotId);
    const previous = await this.createSnapshot(`pre-rollback:${snapshotId}`);
    await fsp.rm(this.filesRoot, { recursive: true, force: true });
    await fsp.mkdir(this.filesRoot, { recursive: true, mode: 0o700 });
    await fsp.cp(snapshotRoot, this.filesRoot, {
      recursive: true,
      errorOnExist: false,
      force: true,
      dereference: false,
    });

    const rollback: VirtualFilesystemRollback = {
      snapshotId,
      projectId: this.projectId,
      rolledBackAt: this.now().toISOString(),
      previousSnapshotId: previous.id,
    };
    await writeJsonAtomic(
      path.join(this.projectRoot, "last-rollback.json"),
      rollback,
    );
    return rollback;
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

  private async measureTree(root: string): Promise<TreeStats> {
    const stat = await lstatOrNull(root);
    if (!stat) return { bytes: 0, fileCount: 0 };
    if (stat.isSymbolicLink()) {
      throw new VirtualFilesystemError(
        "Symlinks are not allowed in the VFS",
        "SYMLINK_DENIED",
      );
    }
    if (stat.isFile()) {
      return { bytes: stat.size, fileCount: 1 };
    }
    if (!stat.isDirectory()) {
      return { bytes: 0, fileCount: 0 };
    }

    let bytes = 0;
    let fileCount = 0;
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      const child = path.join(root, entry.name);
      const stats = await this.measureTree(child);
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

  private async readSnapshot(
    id: string,
  ): Promise<VirtualFilesystemSnapshot | null> {
    const normalizedId = normalizeSnapshotId(id);
    const metadataPath = path.join(
      this.snapshotsRoot,
      normalizedId,
      "snapshot.json",
    );
    const raw = await fsp.readFile(metadataPath, "utf-8").catch(() => null);
    return raw ? (JSON.parse(raw) as VirtualFilesystemSnapshot) : null;
  }

  private async snapshotFilesRoot(id: string): Promise<string> {
    const snapshot = await this.getSnapshot(id);
    const root = path.join(
      this.snapshotsRoot,
      normalizeSnapshotId(snapshot.id),
      "files",
    );
    if (!isWithin(this.snapshotsRoot, root)) {
      throw new VirtualFilesystemError(
        "Snapshot path escapes snapshot root",
        "PATH_TRAVERSAL",
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
  const sanitized = projectId.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new VirtualFilesystemError("Invalid VFS project id", "INVALID_PATH");
  }
  return sanitized.slice(0, 120);
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
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
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
