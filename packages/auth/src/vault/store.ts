/**
 * Legacy JSON vault store helpers used by one-shot migration.
 *
 * Reads and validates the pre-PGlite `vault.json` shape so old installs can
 * be imported into the current storage engine.
 */

import { promises as fs } from "node:fs";
import type { StoredEntry } from "./types.js";

/**
 * On-disk representation of the vault.
 *
 * One file: `<workDir>/vault.json` mode 0600. Atomic writes via temp +
 * rename. No nested structures, no migration framework, no version
 * gates beyond a single integer.
 */

const STORE_VERSION = 1;

export interface StoreData {
  readonly version: number;
  readonly entries: Readonly<Record<string, StoredEntry>>;
}

/** One legacy record that could not be imported. The rest of the file can. */
export interface RejectedStoreEntry {
  readonly key: string;
  readonly reason: string;
}

export interface RecoverableStoreData extends StoreData {
  readonly rejected: readonly RejectedStoreEntry[];
}

class StoreFormatError extends Error {
  constructor(message: string) {
    super(`vault store: ${message}`);
    this.name = "StoreFormatError";
  }
}

function emptyStore(): StoreData {
  return { version: STORE_VERSION, entries: {} };
}

type LoadedStore =
  | { readonly status: "missing" }
  | { readonly status: "parsed"; readonly value: unknown };

async function loadStoreDocument(path: string): Promise<LoadedStore> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    // error-policy:J3 untrusted-input sanitizing — a nonexistent legacy file is
    // the expected "no data yet" state (explicit empty store); any OTHER read
    // error (permissions, I/O) is rethrown, never masked as an empty vault.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // error-policy:J3 untrusted-input sanitizing — a corrupt store file yields
    // an explicit typed StoreFormatError, never a silently-empty vault (which
    // would look healthy while hiding every stored secret).
    throw new StoreFormatError(
      `parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { status: "parsed", value: parsed };
}

export async function readStore(path: string): Promise<StoreData> {
  const loaded = await loadStoreDocument(path);
  if (loaded.status === "missing") return emptyStore();
  const recovered = validateShape(loaded.value, false);
  return { version: recovered.version, entries: recovered.entries };
}

/**
 * Like `readStore`, but a malformed entry is reported in `rejected` instead of
 * failing the whole file. File-level damage (unreadable, invalid JSON, wrong
 * root, or a newer version) still throws.
 */
export async function readRecoverableStore(
  path: string,
): Promise<RecoverableStoreData> {
  const loaded = await loadStoreDocument(path);
  if (loaded.status === "missing") {
    return { version: STORE_VERSION, entries: {}, rejected: [] };
  }
  return validateShape(loaded.value, true);
}

function validateShape(
  parsed: unknown,
  tolerateEntryErrors: boolean,
): RecoverableStoreData {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StoreFormatError("root must be an object");
  }
  const root = parsed as Record<string, unknown>;
  if (typeof root.version !== "number") {
    throw new StoreFormatError("version must be a number");
  }
  const version = root.version;
  if (version > STORE_VERSION) {
    throw new StoreFormatError(
      `version ${version} is newer than supported (${STORE_VERSION})`,
    );
  }
  if (
    !root.entries ||
    typeof root.entries !== "object" ||
    Array.isArray(root.entries)
  ) {
    throw new StoreFormatError("entries must be an object");
  }
  const entriesRaw = root.entries;
  const entries: Record<string, StoredEntry> = {};
  const rejected: RejectedStoreEntry[] = [];
  for (const [key, value] of Object.entries(
    entriesRaw as Record<string, unknown>,
  )) {
    try {
      entries[key] = validateEntry(key, value);
    } catch (err) {
      if (!tolerateEntryErrors || !(err instanceof StoreFormatError)) {
        throw err;
      }
      rejected.push({ key, reason: err.message });
    }
  }
  return { version: STORE_VERSION, entries, rejected };
}

function validateEntry(key: string, raw: unknown): StoredEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new StoreFormatError(`entry ${key}: must be an object`);
  }
  const e = raw as Record<string, unknown>;
  if (typeof e.lastModified !== "number") {
    throw new StoreFormatError(`entry ${key}: lastModified must be a number`);
  }
  const lastModified = e.lastModified;
  if (e.kind === "value") {
    if (typeof e.value !== "string") {
      throw new StoreFormatError(`entry ${key}: value must be a string`);
    }
    return { kind: "value", value: e.value, lastModified };
  }
  if (e.kind === "secret") {
    if (typeof e.ciphertext !== "string" || e.ciphertext.length === 0) {
      throw new StoreFormatError(`entry ${key}: missing ciphertext`);
    }
    return { kind: "secret", ciphertext: e.ciphertext, lastModified };
  }
  if (e.kind === "reference") {
    if (e.source !== "1password" && e.source !== "protonpass") {
      throw new StoreFormatError(`entry ${key}: invalid reference source`);
    }
    if (typeof e.path !== "string" || e.path.length === 0) {
      throw new StoreFormatError(`entry ${key}: missing reference path`);
    }
    return {
      kind: "reference",
      source: e.source,
      path: e.path,
      lastModified,
    };
  }
  throw new StoreFormatError(
    `entry ${key}: unknown kind ${JSON.stringify(e.kind)}`,
  );
}
