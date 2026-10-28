import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { NativeHostError } from "./errors.mjs";

// dlopen retains code for the process lifetime; keep descriptor names unique too.
const loadedLibraries = new Map();
const unavailable = () =>
  new NativeHostError("Encrypted task database driver unavailable", {
    code: "TASK_STORAGE_UNAVAILABLE",
  });
/** Explicit host-only addon admission. No environment discovery or SQLite fallback. */
export function loadTaskSqlCipher({
  libraryPath,
  sha256,
  machine,
  libraryMode,
} = {}) {
  if (
    typeof libraryPath !== "string" ||
    !isAbsolute(libraryPath) ||
    !/^[a-f0-9]{64}$/.test(sha256 ?? "") ||
    ![62, 183].includes(machine) ||
    !["installed-readonly", "android-installed", "private-snapshot"].includes(
      libraryMode,
    )
  )
    throw unavailable();
  let fd, snapshotDirectory;
  try {
    fd = openSync(libraryPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) throw unavailable();
    // Only the privileged root installer is trusted to retain these bytes.
    // A different unprivileged owner can still chmod and rewrite its inode.
    if (
      libraryMode === "installed-readonly" &&
      (process.getuid() === 0 || metadata.uid !== 0 || metadata.mode & 0o022)
    )
      throw unavailable();
    // Android extracts an APK's native libraries as the package installer's
    // system UID (below the first application UID, 10000), never as the app.
    // The app cannot rewrite or chmod such a file; that installer is trusted.
    if (
      libraryMode === "android-installed" &&
      (process.getuid() === 0 ||
        metadata.uid === process.getuid() ||
        metadata.uid >= 10000 ||
        metadata.mode & 0o022)
    )
      throw unavailable();
    const bytes = readFileSync(fd);
    if (
      bytes.length < 20 ||
      bytes.toString("hex", 0, 6) !== "7f454c460201" ||
      bytes.readUInt16LE(18) !== machine ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    )
      throw unavailable();
    const cacheKey = `${libraryMode}:${machine}:${sha256}`;
    const cached = loadedLibraries.get(cacheKey);
    if (cached) return cached.exports;
    if (libraryMode === "private-snapshot") {
      closeSync(fd);
      fd = undefined;
      snapshotDirectory = mkdtempSync(join(tmpdir(), "task-cipher-addon-"));
      const snapshot = join(snapshotDirectory, "addon.so");
      writeFileSync(snapshot, bytes, { flag: "wx", mode: 0o400 });
      fd = openSync(snapshot, constants.O_RDONLY | constants.O_NOFOLLOW);
      // Load only this verified byte snapshot through its descriptor. It has no
      // filesystem name that a concurrent path replacement can redirect.
      unlinkSync(snapshot);
      rmdirSync(snapshotDirectory);
      snapshotDirectory = undefined;
    }
    const addon = { exports: {} };
    process.dlopen(addon, `/proc/self/fd/${fd}`);
    if (
      [
        "acquireLease",
        "releaseLease",
        "open",
        "exec",
        "query",
        "queryAll",
        "close",
        "verify",
      ].some((name) => typeof addon.exports[name] !== "function")
    )
      throw unavailable();
    loadedLibraries.set(cacheKey, { exports: addon.exports, descriptor: fd });
    fd = undefined; // Intentionally retained with the loaded code, not per DB.
    return addon.exports;
  } catch {
    throw unavailable();
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (snapshotDirectory) {
      try {
        unlinkSync(join(snapshotDirectory, "addon.so"));
      } catch {}
      try {
        rmdirSync(snapshotDirectory);
      } catch {}
    }
  }
}
function admitPrivateDirectory(path) {
  const parent = dirname(path),
    directory = statSync(parent);
  if (
    realpathSync(parent) !== parent ||
    !directory.isDirectory() ||
    directory.uid !== process.getuid() ||
    (directory.mode & 0o777) !== 0o700
  )
    throw unavailable();
}
function admitPrivateDatabase(path) {
  admitPrivateDirectory(path);
  let fd;
  try {
    try {
      fd = openSync(
        path,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    const metadata = fstatSync(fd);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== process.getuid() ||
      (metadata.mode & 0o777) !== 0o600
    )
      throw unavailable();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
/** resolveKey returns a fresh, disposable 32-byte Uint8Array for the exact path.
 * The host owns account/session authorization and custody. This adapter wipes the
 * transferred key immediately after native open, including failure. */
export function createSqlCipherTaskProvider({
  libraryPath,
  sha256,
  machine,
  libraryMode,
  resolveKey,
  checkOwner = () => {},
} = {}) {
  if (typeof resolveKey !== "function" || typeof checkOwner !== "function")
    throw unavailable();
  const guard = () => {
    if (checkOwner() !== undefined) throw unavailable();
  };
  const native = loadTaskSqlCipher({
    libraryPath,
    sha256,
    machine,
    libraryMode,
  });
  const connections = new WeakMap();
  return Object.freeze({
    async open({ path }) {
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        path !== resolve(path)
      )
        throw unavailable();
      let key, handle, lease;
      try {
        guard();
        admitPrivateDirectory(path);
        lease = native.acquireLease(path);
        guard();
        key = await resolveKey({ path });
        guard();
        if (!(key instanceof Uint8Array) || key.length !== 32)
          throw unavailable();
        admitPrivateDatabase(path);
        handle = native.open(path, key, lease);
        guard();
      } catch {
        if (handle) native.close(handle);
        throw unavailable();
      } finally {
        if (key instanceof Uint8Array) key.fill(0);
        if (lease) native.releaseLease(lease);
      }
      let closed = false;
      const admitted = () => {
        if (closed) throw unavailable();
        guard();
      };
      const db = Object.freeze({
        exec(sql) {
          admitted();
          const result = native.exec(handle, sql);
          admitted();
          return result;
        },
        prepare(sql) {
          admitted();
          if (typeof sql !== "string" || !sql) throw unavailable();
          return Object.freeze({
            get(...params) {
              admitted();
              const result = native.query(handle, sql, params, true);
              admitted();
              return result;
            },
            run(...params) {
              admitted();
              const result = native.query(handle, sql, params, false);
              admitted();
              return result;
            },
            all(...params) {
              admitted();
              const result = native.queryAll(handle, sql, params);
              admitted();
              return result;
            },
          });
        },
        close() {
          if (!closed) {
            native.close(handle);
            closed = true;
            connections.delete(db);
          }
        },
      });
      connections.set(db, { path, handle });
      return db;
    },
    assertEncryption({ db, path }) {
      const connection = connections.get(db);
      if (!connection || connection.path !== path) throw unavailable();
      guard();
      const verified = native.verify(connection.handle) === true;
      guard();
      return verified;
    },
  });
}
