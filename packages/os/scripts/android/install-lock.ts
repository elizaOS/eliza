/** Same-operator interlock. Interrupted writes require explicit investigation. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function withDeviceInstallLock(
  serial,
  metadata,
  action,
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
    owner.uid !== process.getuid() ||
    (owner.mode & 0o077) !== 0
  )
    throw new Error(
      "installation lock directory must be private and operator-owned",
    );
  const lock = path.join(
    directory,
    `${createHash("sha256").update(serial).digest("hex")}.jsonl`,
  );
  let fd;
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
    if (error.code === "EEXIST")
      throw new Error(
        `device installation locked: ${lock}; inspect the owner, journal and device before manual removal; never retry or remove a live installer's lock`,
      );
    throw error;
  }
  const identity = fs.fstatSync(fd);
  const syncDirectory = () => {
    const parent = fs.openSync(
      directory,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  };
  const removeOwnedLock = () => {
    const current = fs.lstatSync(lock);
    if (current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error("installation lock identity changed; refusing removal");
    fs.unlinkSync(lock);
    syncDirectory();
  };
  let writesStarted = false;
  let completed = false;
  const record = (phase) => {
    fs.writeSync(
      fd,
      `${JSON.stringify({ ...metadata, serial, pid: process.pid, phase, time: new Date().toISOString() })}\n`,
    );
    fs.fsyncSync(fd);
  };
  try {
    record("preflight");
    syncDirectory();
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
