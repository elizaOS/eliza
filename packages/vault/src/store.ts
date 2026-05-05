import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { StoredEntry } from "./types.js";

/**
 * On-disk representation of the vault.
 *
 * One file: `<workDir>/vault.json` mode 0600. Atomic writes via temp +
 * rename. No nested structures, no migration scaffolding, no version
 * gates beyond a single integer.
 */

export const STORE_VERSION = 1;

export interface StoreData {
  readonly version: number;
  readonly entries: Readonly<Record<string, StoredEntry>>;
}

export class StoreFormatError extends Error {
  constructor(message: string) {
    super(`vault store: ${message}`);
    this.name = "StoreFormatError";
  }
}

export function emptyStore(): StoreData {
  return { version: STORE_VERSION, entries: {} };
}

export async function readStore(path: string): Promise<StoreData> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StoreFormatError(
      `parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateShape(parsed);
}

export async function writeStore(path: string, data: StoreData): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  // Per-write tmp filename so two VaultImpl instances cannot collide on the
  // same `${path}.tmp` and silently clobber each other's writes. pid + 8
  // random bytes is overkill for collision avoidance but keeps the cost
  // negligible vs the rest of the write.
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(8).toString("hex")}`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  // mode 0o600 on the tmp file, before rename. POSIX rename preserves mode,
  // so the final file inherits 0o600 with no observable window where it sat
  // at the umask default.
  await fs.writeFile(tmp, body, { mode: 0o600, flag: "w" });
  try {
    await fs.rename(tmp, path);
  } catch (renameErr) {
    // rename failure (cross-device, EROFS, ENOSPC) leaves the tmp file
    // behind. Best-effort cleanup so future writes aren't blocked by stale
    // junk under the same per-pid prefix.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw renameErr;
  }
}

export function setEntry(
  data: StoreData,
  key: string,
  entry: StoredEntry,
): StoreData {
  return {
    version: data.version,
    entries: { ...data.entries, [key]: entry },
  };
}

export function removeEntry(data: StoreData, key: string): StoreData {
  if (!(key in data.entries)) return data;
  const next = { ...data.entries };
  delete next[key];
  return { version: data.version, entries: next };
}

function validateShape(parsed: unknown): StoreData {
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
  for (const [key, value] of Object.entries(
    entriesRaw as Record<string, unknown>,
  )) {
    entries[key] = validateEntry(key, value);
  }
  return { version: STORE_VERSION, entries };
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
