import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { Grant, SecretId, VaultReference, VaultSource } from "./types.js";

/**
 * On-disk representation of a Confidant store.
 *
 * Phase 0 file format. Bumping `version` is the migration trigger; readers
 * must refuse to load a higher version than they recognize.
 */

export const STORE_VERSION = 1;

export interface LiteralEntry {
  readonly kind: "literal";
  readonly source: "file";
  readonly ciphertext: string;
  readonly lastModified: number;
}

export interface ReferenceEntry {
  readonly kind: "reference";
  readonly source: Exclude<VaultSource, "file">;
  readonly ref: VaultReference;
  readonly lastModified: number;
  /** Hint to UIs that this entry should not be moved off-device. */
  readonly deviceBound?: boolean;
}

export type StoreEntry = LiteralEntry | ReferenceEntry;

export interface StorePermissionEntry {
  readonly grants: readonly Grant[];
}

export interface StoreData {
  readonly version: number;
  readonly secrets: Readonly<Record<SecretId, StoreEntry>>;
  readonly permissions: Readonly<Record<string, StorePermissionEntry>>;
}

export function emptyStore(): StoreData {
  return { version: STORE_VERSION, secrets: {}, permissions: {} };
}

export class StoreFormatError extends Error {
  constructor(message: string) {
    super(`Confidant store: ${message}`);
    this.name = "StoreFormatError";
  }
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
      `failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validateStoreShape(parsed);
}

export async function writeStore(path: string, data: StoreData): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(tmp, body, { mode: 0o600, flag: "w" });
  await fs.rename(tmp, path);
  // Re-apply 0600 in case the rename inherited a different umask on the
  // target inode. Idempotent.
  await fs.chmod(path, 0o600);
}

export function setSecret(
  data: StoreData,
  id: SecretId,
  entry: StoreEntry,
): StoreData {
  return {
    ...data,
    secrets: { ...data.secrets, [id]: entry },
  };
}

export function removeSecret(data: StoreData, id: SecretId): StoreData {
  if (!(id in data.secrets)) return data;
  const next = { ...data.secrets };
  delete next[id];
  return { ...data, secrets: next };
}

export function setPermissions(
  data: StoreData,
  skillId: string,
  entry: StorePermissionEntry,
): StoreData {
  return {
    ...data,
    permissions: { ...data.permissions, [skillId]: entry },
  };
}

function validateStoreShape(parsed: unknown): StoreData {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StoreFormatError("root must be an object");
  }
  const root = parsed as Record<string, unknown>;
  const version =
    typeof root.version === "number" ? root.version : STORE_VERSION;
  if (version > STORE_VERSION) {
    throw new StoreFormatError(
      `version ${version} is newer than the supported version ${STORE_VERSION}; refusing to read.`,
    );
  }
  const secretsRaw =
    root.secrets && typeof root.secrets === "object" ? root.secrets : {};
  const secrets: Record<string, StoreEntry> = {};
  for (const [id, entryRaw] of Object.entries(
    secretsRaw as Record<string, unknown>,
  )) {
    secrets[id] = validateEntry(id, entryRaw);
  }
  const permsRaw =
    root.permissions && typeof root.permissions === "object"
      ? root.permissions
      : {};
  const permissions: Record<string, StorePermissionEntry> = {};
  for (const [skill, entryRaw] of Object.entries(
    permsRaw as Record<string, unknown>,
  )) {
    permissions[skill] = validatePermissionEntry(skill, entryRaw);
  }
  return { version: STORE_VERSION, secrets, permissions };
}

function validateEntry(id: string, raw: unknown): StoreEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new StoreFormatError(`secret entry ${id}: must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  const kind = entry.kind;
  const lastModified =
    typeof entry.lastModified === "number" ? entry.lastModified : 0;
  if (kind === "literal") {
    const ciphertext = entry.ciphertext;
    if (typeof ciphertext !== "string" || ciphertext.length === 0) {
      throw new StoreFormatError(
        `secret entry ${id}: literal entries require non-empty ciphertext`,
      );
    }
    return {
      kind: "literal",
      source: "file",
      ciphertext,
      lastModified,
    };
  }
  if (kind === "reference") {
    const ref = entry.ref;
    const source = entry.source;
    if (typeof ref !== "string" || ref.length === 0) {
      throw new StoreFormatError(
        `secret entry ${id}: reference entries require non-empty ref`,
      );
    }
    if (
      source !== "keyring" &&
      source !== "1password" &&
      source !== "protonpass" &&
      source !== "cloud" &&
      source !== "env-legacy"
    ) {
      throw new StoreFormatError(
        `secret entry ${id}: invalid reference source ${JSON.stringify(source)}`,
      );
    }
    const deviceBound =
      typeof entry.deviceBound === "boolean" ? entry.deviceBound : undefined;
    const refEntry: ReferenceEntry = {
      kind: "reference",
      source,
      ref,
      lastModified,
      ...(deviceBound !== undefined ? { deviceBound } : {}),
    };
    return refEntry;
  }
  throw new StoreFormatError(
    `secret entry ${id}: unknown kind ${JSON.stringify(kind)}`,
  );
}

function validatePermissionEntry(
  skillId: string,
  raw: unknown,
): StorePermissionEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new StoreFormatError(`permission entry ${skillId}: must be an object`);
  }
  const entry = raw as Record<string, unknown>;
  const grantsRaw = Array.isArray(entry.grants) ? entry.grants : [];
  const grants: Grant[] = [];
  for (const grantRaw of grantsRaw) {
    if (!grantRaw || typeof grantRaw !== "object") continue;
    const g = grantRaw as Record<string, unknown>;
    if (typeof g.pattern !== "string") continue;
    const mode =
      g.mode === "always" ||
      g.mode === "prompt" ||
      g.mode === "audit" ||
      g.mode === "deny"
        ? g.mode
        : "deny";
    const grantedAt = typeof g.grantedAt === "number" ? g.grantedAt : 0;
    const reason = typeof g.reason === "string" ? g.reason : undefined;
    grants.push({
      pattern: g.pattern,
      mode,
      grantedAt,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
  return { grants };
}
