/** Same-operator interlock. Interrupted writes require explicit investigation. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function syncDirectory(directory: string) {
  const fd = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Include new ancestor directory entries, not just the leaf's contents. */
export function syncDirectoryTree(directory: string) {
  let current = path.resolve(directory);
  while (true) {
    syncDirectory(current);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function withDeviceInstallLock<T>(
  serial: string,
  metadata: Record<string, unknown>,
  action: (lock: { beforeWrites(): void }) => T,
  directory = path.join(
    os.homedir(),
    ".local/state/elizaos/android-install-locks",
  ),
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(serial))
    throw new Error("invalid installation lock serial");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const owner = fs.lstatSync(directory);
  if (
    !owner.isDirectory() ||
    owner.isSymbolicLink() ||
    owner.uid !== process.getuid?.() ||
    (owner.mode & 0o077) !== 0
  )
    throw new Error(
      "installation lock directory must be private and operator-owned",
    );
  const lock = path.join(
    directory,
    `${createHash("sha256").update(serial).digest("hex")}.jsonl`,
  );
  let fd: number;
  try {
    fd = fs.openSync(
      lock,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(
        `device installation locked: ${lock}; inspect the owner, journal and device before manual removal; never retry or remove a live installer's lock`,
      );
    throw error;
  }
  const identity = fs.fstatSync(fd);
  const removeOwnedLock = () => {
    const current = fs.lstatSync(lock);
    if (current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error("installation lock identity changed; refusing removal");
    fs.unlinkSync(lock);
    syncDirectory(directory);
  };
  let writesStarted = false;
  let completed = false;
  const record = (phase: string) => {
    fs.writeFileSync(
      fd,
      `${JSON.stringify({ ...metadata, serial, pid: process.pid, phase, time: new Date().toISOString() })}\n`,
    );
    fs.fsyncSync(fd);
  };
  try {
    record("preflight");
    syncDirectoryTree(directory);
    const result = action({
      beforeWrites() {
        writesStarted = true;
        record("writes-started");
      },
    });
    completed = true;
    return result;
  } finally {
    fs.closeSync(fd);
    if (completed || !writesStarted) {
      removeOwnedLock();
    }
    // Failed writes and process death leave the lock in place. PID reuse and
    // incomplete device state make automatic stale-lock recovery unsafe.
  }
}
