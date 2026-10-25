/**
 * Private directory and file primitives for the restore-v3 serving roots.
 * Every directory must be a real, non-symlinked 0700 directory owned by the
 * current uid; every file a single-link 0600 regular file owned by it. Writes
 * are tmp + fsync + rename + directory fsync. Callers own the exclusivity of
 * these roots; the checks detect, rather than prevent, a same-uid writer.
 */

import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentBackupRestoreV3FsIdentity } from "@elizaos/contracts/node";
import { servingError } from "./agent-backup-restore-v3-serving-wire";

function currentUid(): number {
  if (typeof process.getuid !== "function")
    throw servingError("PLATFORM_UNSUPPORTED");
  return process.getuid();
}

function isErrno(cause: unknown, code: string): boolean {
  return (
    cause instanceof Error && (cause as NodeJS.ErrnoException).code === code
  );
}

export function sameServingIdentity(
  left: AgentBackupRestoreV3FsIdentity,
  right: AgentBackupRestoreV3FsIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function identityOf(stats: {
  dev: bigint;
  ino: bigint;
}): AgentBackupRestoreV3FsIdentity {
  return Object.freeze({
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
  });
}

async function syncDirectoryPath(directory: string): Promise<void> {
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Proves an existing canonical private directory and returns its identity. */
export async function inspectPrivateDirectory(
  target: string,
): Promise<AgentBackupRestoreV3FsIdentity> {
  if (!path.isAbsolute(target) || path.resolve(target) !== target)
    throw servingError("ROOT_UNSAFE");
  const stats = await fs.lstat(target, { bigint: true });
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (Number(stats.mode) & 0o7077) !== 0 ||
    stats.uid !== BigInt(currentUid()) ||
    (await fs.realpath(target)) !== target
  )
    throw servingError("ROOT_UNSAFE");
  const after = await fs.lstat(target, { bigint: true });
  if (after.dev !== stats.dev || after.ino !== stats.ino)
    throw servingError("ROOT_CHANGED");
  return identityOf(stats);
}

/**
 * Proves the pre-existing container data root: a canonical real directory,
 * owned by this uid or root, and not writable by group or others.
 */
export async function inspectServingDataRoot(target: string): Promise<void> {
  if (!path.isAbsolute(target) || path.resolve(target) !== target)
    throw servingError("ROOT_UNSAFE");
  const stats = await fs.lstat(target, { bigint: true });
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (Number(stats.mode) & 0o022) !== 0 ||
    (stats.uid !== BigInt(currentUid()) && stats.uid !== 0n) ||
    (await fs.realpath(target)) !== target
  )
    throw servingError("ROOT_UNSAFE");
}

/** Idempotently creates one private directory beneath an already-proven parent. */
export async function ensurePrivateDirectory(
  target: string,
): Promise<AgentBackupRestoreV3FsIdentity> {
  let created = false;
  try {
    await fs.mkdir(target, { mode: 0o700 });
    created = true;
  } catch (cause) {
    // error-policy:J3 An existing entry is re-proven below; anything else fails.
    if (!isErrno(cause, "EEXIST")) throw servingError("ROOT_UNSAFE", cause);
  }
  const identity = await inspectPrivateDirectory(target);
  if (created) await syncDirectoryPath(path.dirname(target));
  return identity;
}

/** Reads one private file, or null when it does not exist. */
export async function readPrivateFile(
  directory: string,
  name: string,
  maximumBytes: number,
): Promise<Buffer | null> {
  const target = path.join(directory, name);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (cause) {
    // error-policy:J3 Only an absent file is the empty state.
    if (isErrno(cause, "ENOENT")) return null;
    throw servingError("FILE_UNSAFE", cause);
  }
  let bytes: Buffer | undefined;
  try {
    const opened = await handle.stat({ bigint: true });
    const visible = await fs.lstat(target, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      (Number(opened.mode) & 0o7077) !== 0 ||
      opened.uid !== BigInt(currentUid()) ||
      opened.size <= 0n ||
      opened.size > BigInt(maximumBytes) ||
      visible.dev !== opened.dev ||
      visible.ino !== opened.ino
    )
      throw servingError("FILE_UNSAFE");
    bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) throw servingError("FILE_CHANGED");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs)
      throw servingError("FILE_CHANGED");
    const result = bytes;
    bytes = undefined;
    return result;
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}

/** Atomically publishes a private file (tmp + fsync + rename + dir fsync). */
export async function writePrivateFileAtomic(
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const target = path.join(directory, name);
  const temporary = path.join(directory, `${name}.tmp`);
  try {
    await fs.unlink(temporary);
  } catch (cause) {
    // error-policy:J3 A missing temporary is the ordinary state.
    if (!isErrno(cause, "ENOENT")) throw servingError("FILE_UNSAFE", cause);
  }
  const handle = await fs.open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesWritten <= 0) throw servingError("FILE_WRITE_FAILED");
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, target);
  await syncDirectoryPath(directory);
}

/** Removes one private file and makes the removal durable. */
export async function unlinkPrivateFile(
  directory: string,
  name: string,
): Promise<void> {
  await fs.unlink(path.join(directory, name));
  await syncDirectoryPath(directory);
}
