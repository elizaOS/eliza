/** Private host file replacement with file and directory durability. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Directory fsync is unsupported on Windows and on a small set of
    // filesystems. Real I/O failures must remain observable to the caller.
    if (
      process.platform !== "win32" &&
      code !== "EINVAL" &&
      code !== "ENOTSUP" &&
      code !== "EOPNOTSUPP" &&
      code !== "EISDIR"
    ) {
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
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
