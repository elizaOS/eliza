/** Private host file replacement with file and directory durability. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";

/**
 * Directory fsync is unsupported on Windows (it fails with EPERM) and on a
 * small set of filesystems. Real I/O failures must remain observable to the
 * caller.
 */
function isUnsupportedDirectorySync(error: unknown): boolean {
  if (process.platform === "win32") return true;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EINVAL" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "EISDIR"
  );
}

function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Persist the entries of `dir` (a create, rename or unlink in it). A directory
 * that cannot be opened is an error; a platform that cannot fsync a directory
 * is not.
 */
export async function syncDirectoryAsync(
  dir: string,
  flags: number = fs.constants.O_RDONLY,
): Promise<void> {
  const handle = await fsPromises.open(dir, flags);
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}

export function writeFileAtomically(
  targetPath: string,
  content: string,
  rename: typeof fs.renameSync = fs.renameSync,
): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    rename(tmpPath, targetPath);
    syncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Preserve the original write error. A stale uniquely named temp is safe.
    }
    throw error;
  }
}
