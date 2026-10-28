import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { NativeHostError } from "./errors.mjs";

/**
 * Task-data key derivation and sealing for the files a host keeps beside the
 * encrypted task database (outcome journal, task evidence, diagnostics).
 *
 * The host keeps one 256-bit data key per account in native custody. Two keys
 * are derived from it with HKDF-SHA256 and are never stored: the database key
 * for the SQLCipher provider and the file key for sealing. A sealed value is
 * one ASCII line: `<namespace>-sealed-v1.` + base64url(IV, ciphertext, tag),
 * AES-256-GCM with the purpose authenticated, so a value of one store cannot
 * be read as another. The namespace separates hosts; a host must keep its
 * namespace stable, or its existing sealed data can no longer be read.
 */

const NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/;
const PURPOSE = /^[a-z][a-z0-9:-]{0,63}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const failure = (message = "Encrypted task storage is unavailable") =>
  new NativeHostError(message, { code: "TASK_STORAGE_UNAVAILABLE" });

const checkNamespace = (namespace) => {
  if (typeof namespace !== "string" || !NAMESPACE.test(namespace))
    throw failure("Invalid task storage namespace");
  return namespace;
};
const checkKey = (key, message) => {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw failure(message);
};

/** The line prefix of every value sealed under `namespace`. */
export const sealedPrefix = (namespace) =>
  `${checkNamespace(namespace)}-sealed-v1.`;

/**
 * The database and file keys of one 32-byte data key. The caller wipes
 * `master`; call `wipe()` on the result when the keys are no longer used.
 */
export function deriveTaskKeys(master, { namespace } = {}) {
  checkNamespace(namespace);
  checkKey(master, "Invalid task data key");
  const derive = (label) =>
    Buffer.from(
      hkdfSync(
        "sha256",
        master,
        Buffer.alloc(0),
        `${namespace}/${label}/v1`,
        32,
      ),
    );
  const keys = {
    database: derive("task-database"),
    files: derive("task-files"),
  };
  return {
    ...keys,
    wipe() {
      keys.database.fill(0);
      keys.files.fill(0);
    },
  };
}

/** AES-256-GCM text sealing under a 32-byte file key. */
export function createTaskSealer(fileKey, { namespace } = {}) {
  const prefix = sealedPrefix(namespace);
  checkKey(fileKey, "Invalid task file key");
  const key = Buffer.from(fileKey);
  const aad = (purpose) => {
    if (typeof purpose !== "string" || !PURPOSE.test(purpose))
      throw failure("Invalid sealing purpose");
    return Buffer.from(`${namespace}/sealed/v1/${purpose}`);
  };
  let wiped = false;
  const live = () => {
    if (wiped) throw failure("Task file key was retired");
  };
  return Object.freeze({
    seal(text, purpose) {
      live();
      if (typeof text !== "string") throw failure("Only text is sealed");
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad(purpose));
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return (
        prefix +
        Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")
      );
    },
    open(value, purpose) {
      live();
      if (typeof value !== "string" || !value.startsWith(prefix))
        throw failure("Not a sealed task record");
      const encoded = value.slice(prefix.length);
      const bytes = Buffer.from(encoded, "base64url");
      // Reject non-canonical base64url: Buffer.from ignores invalid characters.
      if (
        bytes.length < IV_BYTES + TAG_BYTES ||
        bytes.toString("base64url") !== encoded
      )
        throw failure("Invalid sealed task record");
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          bytes.subarray(0, IV_BYTES),
        );
        decipher.setAAD(aad(purpose));
        decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
        return Buffer.concat([
          decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw failure("A sealed task record did not authenticate");
      }
    },
    isSealed: (value) => typeof value === "string" && value.startsWith(prefix),
    wipe() {
      wiped = true;
      key.fill(0);
    },
  });
}

/** Text codec for one purpose, e.g. the bill outcome store's `journalCodec`. */
export const sealedTextCodec = (sealer, purpose) =>
  Object.freeze({
    encode: (text) => sealer.seal(text, purpose),
    decode: (value) => sealer.open(value, purpose),
  });

/** Evidence codec for the bill helper's `evidenceCodec`: `<id>.sealed` files. */
export const sealedEvidenceCodec = (sealer, purpose = "task-evidence") =>
  Object.freeze({
    extension: ".sealed",
    encode: (text) => sealer.seal(text, purpose),
  });

function syncDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    /* Not every platform can fsync a directory handle. */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Atomic owner-only write. The data goes to a new 0600 temporary file in the
 * same directory, is synced and renamed over `path`, then the directory is
 * synced. A reader sees the old contents or the new, never a part. A missing
 * directory is created 0700.
 */
export function writePrivateFileSync(path, data) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  syncDirectory(directory);
}

/**
 * Read/write ports for one sealed text file (one sealed line per file). A
 * missing file keeps its ENOENT; a file that does not authenticate fails.
 */
export const sealedFilePorts = (sealer, purpose) =>
  Object.freeze({
    writeFile: (path, text) =>
      writePrivateFileSync(path, `${sealer.seal(text, purpose)}\n`),
    readFile: (path) =>
      sealer.open(readFileSync(path, "utf8").trimEnd(), purpose),
    removeFile: (path) => rmSync(path, { force: true }),
  });
