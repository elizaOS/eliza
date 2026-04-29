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
  const tmp = `${path}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tmp, body, { mode: 0o600, flag: "w" });
  await fs.rename(tmp, path);
  await fs.chmod(path, 0o600);
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
  const version = typeof root.version === "number" ? root.version : STORE_VERSION;
  if (version > STORE_VERSION) {
    throw new StoreFormatError(
      `version ${version} is newer than supported (${STORE_VERSION})`,
    );
  }
  const entriesRaw =
    root.entries && typeof root.entries === "object" ? root.entries : {};
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
  const lastModified = typeof e.lastModified === "number" ? e.lastModified : 0;
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
  throw new StoreFormatError(`entry ${key}: unknown kind ${JSON.stringify(e.kind)}`);
}
