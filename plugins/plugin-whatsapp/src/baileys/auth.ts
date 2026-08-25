/**
 * Owns crash-durable Baileys authentication state for personal WhatsApp accounts.
 * Each account is confined to connector-owned state; credentials and Signal keys
 * commit together as one atomic snapshot.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { ElizaError, logger, resolveStateDir } from "@elizaos/core";
import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";

const AUTH_VERSION = 1;
const OWNER_FILE = ".eliza-whatsapp-auth.json";
const SNAPSHOT_FILE = "auth-state.json";
const COMMIT_FILE = ".auth-state.commit.json";
const TEMP_PREFIX = ".auth-state.json.tmp-";
const TEMP_PATTERN =
  /^\.auth-state\.json\.tmp-\d+-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCOUNT_ID_PATTERN = /^[a-z0-9_-]+$/;
const SIGNAL_KEY_TYPES = new Set<keyof SignalDataTypeMap>([
  "pre-key",
  "session",
  "sender-key",
  "sender-key-memory",
  "app-state-sync-key",
  "app-state-sync-version",
  "lid-mapping",
  "device-list",
  "tctoken",
  "identity-key",
]);

export interface BaileysAuthPersistenceHooks {
  beforeRename?: (filename: string, phase: AuthWritePhase) => Promise<void>;
  afterRename?: (filename: string, phase: AuthWritePhase) => Promise<void>;
  beforeLogoutDelete?: () => Promise<void>;
  beforeTempCleanup?: (filename: string) => Promise<void>;
}

export type AuthWritePhase =
  | "owner"
  | "commit-pending"
  | "snapshot"
  | "commit-confirmed"
  | "commit-restore";

interface PersistedAuthState {
  version: typeof AUTH_VERSION;
  accountId: string;
  creds: AuthenticationCreds;
  keys: Partial<{ [K in keyof SignalDataTypeMap]: Record<string, SignalDataTypeMap[K]> }>;
}

interface OwnerRecord {
  version: typeof AUTH_VERSION;
  accountId: string;
}

interface CommitRecord {
  version: typeof AUTH_VERSION;
  accountId: string;
  state: "pending" | "confirmed";
  snapshotHash: string;
}

const activeAccountPaths = new Map<string, string>();
interface AccountLifecycle {
  tail: Promise<void>;
  generation: number;
  active: boolean;
}
const accountLifecycles = new Map<string, AccountLifecycle>();

function authError(
  code: string,
  message: string,
  context: Record<string, unknown>,
  cause?: unknown
): ElizaError {
  return new ElizaError(message, { code, context, cause, severity: "fatal" });
}

export function validateWhatsAppAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw authError(
      "WHATSAPP_AUTH_INVALID_ACCOUNT_ID",
      "WhatsApp account IDs must use lowercase letters, numbers, dashes, or underscores",
      { accountId }
    );
  }
  return accountId;
}

export function resolveWhatsAppAuthDirectory(
  accountId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(
    resolveStateDir(env),
    "connectors",
    "whatsapp",
    "accounts",
    validateWhatsAppAccountId(accountId)
  );
}

function assertAuthoritativeDirectory(accountId: string, configuredAuthDir?: string): string {
  const expected = resolveWhatsAppAuthDirectory(accountId);
  if (configuredAuthDir && path.resolve(configuredAuthDir) !== expected) {
    throw authError(
      "WHATSAPP_AUTH_DIRECTORY_OUTSIDE_STATE_AUTHORITY",
      "Personal WhatsApp auth must use its connector-owned account directory",
      { accountId, configuredAuthDir: path.resolve(configuredAuthDir), expectedAuthDir: expected }
    );
  }
  const priorAccount = activeAccountPaths.get(expected);
  if (priorAccount && priorAccount !== accountId) {
    throw authError(
      "WHATSAPP_AUTH_ACCOUNT_COLLISION",
      "Two WhatsApp accounts resolved to the same auth directory",
      { accountId, conflictingAccountId: priorAccount, authDir: expected }
    );
  }
  activeAccountPaths.set(expected, accountId);
  return expected;
}

async function lstatIfPresent(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // error-policy:J2 The auth boundary adds the exact path before rethrowing filesystem failures.
    throw authError(
      "WHATSAPP_AUTH_FILESYSTEM_FAILED",
      "Could not inspect WhatsApp auth storage",
      { target },
      error
    );
  }
}

async function ensureOwnedDirectory(target: string): Promise<void> {
  const existing = await lstatIfPresent(target);
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw authError("WHATSAPP_AUTH_SYMLINK_REJECTED", "WhatsApp auth paths cannot be symlinks", {
        target,
      });
    }
    if (!existing.isDirectory()) {
      throw authError("WHATSAPP_AUTH_INVALID_PATH", "WhatsApp auth path must be a directory", {
        target,
      });
    }
    return;
  }
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return ensureOwnedDirectory(target);
    }
    // error-policy:J2 Directory creation failures retain their filesystem cause and target.
    throw authError(
      "WHATSAPP_AUTH_FILESYSTEM_FAILED",
      "Could not create WhatsApp auth storage",
      { target },
      error
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(
  directory: string,
  filename: string,
  contents: string,
  phase: AuthWritePhase,
  hooks?: BaileysAuthPersistenceHooks
): Promise<void> {
  const target = path.join(directory, filename);
  const temp = path.join(
    directory,
    `${TEMP_PREFIX}${process.pid}-${Date.now()}-${crypto.randomUUID()}`
  );
  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks?.beforeRename?.(filename, phase);
    await rename(temp, target);
    renamed = true;
    await hooks?.afterRename?.(filename, phase);
    await syncDirectory(directory);
  } catch (error) {
    // error-policy:J2 Commit failures preserve their cause and distinguish pre-rename failure from ambiguous durability.
    throw authError(
      renamed ? "WHATSAPP_AUTH_COMMIT_AMBIGUOUS" : "WHATSAPP_AUTH_ATOMIC_WRITE_FAILED",
      renamed
        ? "WhatsApp auth state was renamed but directory durability could not be confirmed"
        : "Could not atomically persist WhatsApp auth state",
      { directory, filename, phase, commitState: renamed ? "ambiguous" : "unchanged" },
      error
    );
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // error-policy:J6 A primary atomic-write failure remains authoritative over handle cleanup.
        logger.warn(
          { directory, filename },
          "[WhatsAppAuth] Failed to close a temporary auth file after write failure"
        );
      }
    }
    if (!renamed) {
      try {
        await hooks?.beforeTempCleanup?.(filename);
        await rm(temp, { force: true });
      } catch {
        // error-policy:J6 A primary atomic-write failure remains authoritative over temporary-file cleanup.
        logger.warn(
          { directory, filename },
          "[WhatsAppAuth] Failed to clean a temporary auth file after write failure"
        );
      }
    }
  }
}

function lifecycleFor(authDir: string): AccountLifecycle {
  let lifecycle = accountLifecycles.get(authDir);
  if (!lifecycle) {
    lifecycle = { tail: Promise.resolve(), generation: 0, active: false };
    accountLifecycles.set(authDir, lifecycle);
  }
  return lifecycle;
}

async function enqueueAccountOperation<T>(
  authDir: string,
  operation: (lifecycle: AccountLifecycle) => Promise<T>
): Promise<T> {
  const lifecycle = lifecycleFor(authDir);
  const next = lifecycle.tail.then(() => operation(lifecycle));
  // error-policy:J5 The returned `await next` is the sole observer; the lifecycle tail only keeps later work ordered.
  lifecycle.tail = next.then(
    () => undefined,
    () => undefined
  );
  return await next;
}

async function prepareAccountDirectory(
  accountId: string,
  configuredAuthDir?: string,
  hooks?: BaileysAuthPersistenceHooks
): Promise<string> {
  const authDir = assertAuthoritativeDirectory(accountId, configuredAuthDir);
  const stateDir = resolveStateDir();
  if (!(await lstatIfPresent(stateDir))) {
    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      // error-policy:J2 State-authority creation retains the selected root and filesystem cause.
      throw authError(
        "WHATSAPP_AUTH_FILESYSTEM_FAILED",
        "Could not create the elizaOS state authority for WhatsApp auth",
        { stateDir },
        error
      );
    }
  }
  const segments = [
    stateDir,
    path.join(stateDir, "connectors"),
    path.join(stateDir, "connectors", "whatsapp"),
    path.join(stateDir, "connectors", "whatsapp", "accounts"),
    authDir,
  ];
  for (const segment of segments) await ensureOwnedDirectory(segment);

  const entries = await readdir(authDir, { withFileTypes: true });
  const ownerPath = path.join(authDir, OWNER_FILE);
  const ownerStat = await lstatIfPresent(ownerPath);
  if (!ownerStat) {
    if (entries.length > 0) {
      const entry = entries[0];
      throw authError(
        entry.isSymbolicLink() ? "WHATSAPP_AUTH_SYMLINK_REJECTED" : "WHATSAPP_AUTH_FOREIGN_CONTENT",
        "An unowned WhatsApp auth directory must be empty",
        { accountId, authDir, entry: entry.name }
      );
    }
    await atomicWrite(
      authDir,
      OWNER_FILE,
      JSON.stringify({ version: AUTH_VERSION, accountId }),
      "owner",
      hooks
    );
  } else {
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.nlink !== 1) {
      throw authError(
        ownerStat.isSymbolicLink()
          ? "WHATSAPP_AUTH_SYMLINK_REJECTED"
          : ownerStat.nlink !== 1
            ? "WHATSAPP_AUTH_HARDLINK_REJECTED"
            : "WHATSAPP_AUTH_FOREIGN_CONTENT",
        "WhatsApp auth ownership metadata must be one regular, unlinked file",
        { accountId, authDir, entry: OWNER_FILE }
      );
    }
    let owner: OwnerRecord;
    try {
      owner = JSON.parse(await readFile(ownerPath, "utf8")) as OwnerRecord;
    } catch (error) {
      // error-policy:J2 Ownership metadata corruption must remain visible at the authority boundary.
      throw authError(
        "WHATSAPP_AUTH_OWNER_CORRUPT",
        "WhatsApp auth ownership metadata is corrupt",
        { accountId, authDir },
        error
      );
    }
    if (
      !isPlainRecord(owner) ||
      !hasExactKeys(owner, ["version", "accountId"]) ||
      owner.version !== AUTH_VERSION ||
      owner.accountId !== accountId
    ) {
      throw authError(
        "WHATSAPP_AUTH_ACCOUNT_COLLISION",
        "WhatsApp auth directory belongs to another account",
        { accountId, ownerAccountId: owner.accountId, authDir }
      );
    }
  }

  for (const entry of entries) {
    if (entry.name === OWNER_FILE) continue;
    const entryPath = path.join(authDir, entry.name);
    const entryStat = await lstatIfPresent(entryPath);
    if (!entryStat) continue;
    if (entryStat.isSymbolicLink()) {
      throw authError("WHATSAPP_AUTH_SYMLINK_REJECTED", "WhatsApp auth paths cannot be symlinks", {
        accountId,
        authDir,
        entry: entry.name,
      });
    }
    if (!entryStat.isFile() || entryStat.nlink !== 1) {
      throw authError(
        entryStat.nlink !== 1 ? "WHATSAPP_AUTH_HARDLINK_REJECTED" : "WHATSAPP_AUTH_FOREIGN_CONTENT",
        "WhatsApp auth directory entries must be connector-owned regular files",
        { accountId, authDir, entry: entry.name }
      );
    }
    if (entry.name === SNAPSHOT_FILE || entry.name === COMMIT_FILE) continue;
    if (TEMP_PATTERN.test(entry.name)) {
      await rm(entryPath);
      continue;
    }
    throw authError(
      "WHATSAPP_AUTH_FOREIGN_CONTENT",
      "WhatsApp auth directory contains content not owned by this connector",
      { accountId, authDir, entry: entry.name }
    );
  }
  return authDir;
}

async function validateAccountDirectoryReadOnly(accountId: string, authDir: string): Promise<void> {
  const directoryStat = await lstatIfPresent(authDir);
  if (!directoryStat) {
    throw authError("WHATSAPP_AUTH_NOT_FOUND", "WhatsApp auth directory does not exist", {
      accountId,
      authDir,
    });
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw authError(
      directoryStat.isSymbolicLink()
        ? "WHATSAPP_AUTH_SYMLINK_REJECTED"
        : "WHATSAPP_AUTH_INVALID_PATH",
      "WhatsApp auth account path must be a dedicated directory",
      { accountId, authDir }
    );
  }
  const entries = await readdir(authDir, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  if (
    !hasExactKeys(Object.fromEntries(names.map((name) => [name, true])), [
      OWNER_FILE,
      SNAPSHOT_FILE,
      COMMIT_FILE,
    ])
  ) {
    throw authError(
      "WHATSAPP_AUTH_FOREIGN_CONTENT",
      "WhatsApp auth status requires exactly one owner record and one committed snapshot",
      { accountId, authDir, entries: names }
    );
  }
  for (const filename of [OWNER_FILE, SNAPSHOT_FILE, COMMIT_FILE]) {
    const fileStat = await lstatIfPresent(path.join(authDir, filename));
    if (!fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) {
      throw authError(
        fileStat?.isSymbolicLink()
          ? "WHATSAPP_AUTH_SYMLINK_REJECTED"
          : fileStat && fileStat.nlink !== 1
            ? "WHATSAPP_AUTH_HARDLINK_REJECTED"
            : "WHATSAPP_AUTH_FOREIGN_CONTENT",
        "WhatsApp auth status requires regular, unlinked connector files",
        { accountId, authDir, entry: filename }
      );
    }
  }

  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(path.join(authDir, OWNER_FILE), "utf8"));
  } catch (error) {
    // error-policy:J2 Read-only status retains corrupt owner metadata and its parse cause.
    throw authError(
      "WHATSAPP_AUTH_OWNER_CORRUPT",
      "WhatsApp auth ownership metadata is corrupt",
      { accountId, authDir },
      error
    );
  }
  if (
    !isPlainRecord(owner) ||
    !hasExactKeys(owner, ["version", "accountId"]) ||
    owner.version !== AUTH_VERSION ||
    owner.accountId !== accountId
  ) {
    throw authError(
      "WHATSAPP_AUTH_ACCOUNT_COLLISION",
      "WhatsApp auth directory belongs to another account",
      { accountId, authDir, ownerAccountId: isPlainRecord(owner) ? owner.accountId : undefined }
    );
  }

  let snapshotText: string;
  let snapshot: unknown;
  try {
    snapshotText = await readFile(path.join(authDir, SNAPSHOT_FILE), "utf8");
    snapshot = JSON.parse(snapshotText, BufferJSON.reviver);
  } catch (error) {
    // error-policy:J2 Read-only status retains corrupt snapshot bytes and their parse cause.
    throw authError(
      "WHATSAPP_AUTH_SNAPSHOT_CORRUPT",
      "WhatsApp auth snapshot is corrupt",
      { accountId, authDir },
      error
    );
  }
  validateSnapshot(snapshot, accountId, authDir);
  validateCommitRecord(
    await readFile(path.join(authDir, COMMIT_FILE), "utf8"),
    accountId,
    authDir,
    snapshotText
  );
}

async function validateAccountOwnershipForDeletion(
  accountId: string,
  authDir: string
): Promise<void> {
  const directoryStat = await lstatIfPresent(authDir);
  if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
    throw authError(
      directoryStat?.isSymbolicLink()
        ? "WHATSAPP_AUTH_SYMLINK_REJECTED"
        : "WHATSAPP_AUTH_INVALID_PATH",
      "WhatsApp auth deletion requires a dedicated account directory",
      { accountId, authDir }
    );
  }
  const entries = await readdir(authDir, { withFileTypes: true });
  if (!entries.some((entry) => entry.name === OWNER_FILE)) {
    throw authError(
      "WHATSAPP_AUTH_OWNER_MISSING",
      "WhatsApp auth deletion requires connector ownership metadata",
      { accountId, authDir }
    );
  }
  for (const entry of entries) {
    if (
      entry.name !== OWNER_FILE &&
      entry.name !== SNAPSHOT_FILE &&
      entry.name !== COMMIT_FILE &&
      !TEMP_PATTERN.test(entry.name)
    ) {
      throw authError(
        "WHATSAPP_AUTH_FOREIGN_CONTENT",
        "WhatsApp auth deletion refused a directory containing foreign content",
        { accountId, authDir, entry: entry.name }
      );
    }
    const fileStat = await lstatIfPresent(path.join(authDir, entry.name));
    if (!fileStat?.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) {
      throw authError(
        fileStat?.isSymbolicLink()
          ? "WHATSAPP_AUTH_SYMLINK_REJECTED"
          : fileStat && fileStat.nlink !== 1
            ? "WHATSAPP_AUTH_HARDLINK_REJECTED"
            : "WHATSAPP_AUTH_FOREIGN_CONTENT",
        "WhatsApp auth deletion requires regular, unlinked connector files",
        { accountId, authDir, entry: entry.name }
      );
    }
  }
  let owner: unknown;
  try {
    owner = JSON.parse(await readFile(path.join(authDir, OWNER_FILE), "utf8"));
  } catch (error) {
    // error-policy:J2 Deletion cannot proceed without parseable ownership metadata.
    throw authError(
      "WHATSAPP_AUTH_OWNER_CORRUPT",
      "WhatsApp auth ownership metadata is corrupt",
      { accountId, authDir },
      error
    );
  }
  if (
    !isPlainRecord(owner) ||
    !hasExactKeys(owner, ["version", "accountId"]) ||
    owner.version !== AUTH_VERSION ||
    owner.accountId !== accountId
  ) {
    throw authError(
      "WHATSAPP_AUTH_ACCOUNT_COLLISION",
      "WhatsApp auth directory belongs to another account",
      { accountId, authDir, ownerAccountId: isPlainRecord(owner) ? owner.accountId : undefined }
    );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function isKeyPair(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["public", "private"]) &&
    isBytes(value.public) &&
    isBytes(value.private)
  );
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateCredentials(creds: unknown): creds is AuthenticationCreds {
  if (!isPlainRecord(creds)) return false;
  if (!isKeyPair(creds.noiseKey) || !isKeyPair(creds.pairingEphemeralKeyPair)) return false;
  if (!isKeyPair(creds.signedIdentityKey) || !isPlainRecord(creds.signedPreKey)) return false;
  const signedPreKey = creds.signedPreKey;
  if (!isKeyPair(signedPreKey.keyPair) || !isBytes(signedPreKey.signature)) return false;
  if (!isSafeInteger(signedPreKey.keyId) || !isSafeInteger(creds.registrationId)) return false;
  if (typeof creds.advSecretKey !== "string" || !Array.isArray(creds.processedHistoryMessages))
    return false;
  if (!isSafeInteger(creds.firstUnuploadedPreKeyId) || !isSafeInteger(creds.nextPreKeyId))
    return false;
  if (!isSafeInteger(creds.accountSyncCounter) || !isPlainRecord(creds.accountSettings))
    return false;
  if (typeof creds.accountSettings.unarchiveChats !== "boolean") return false;
  if (typeof creds.registered !== "boolean") return false;
  if (creds.pairingCode !== undefined && typeof creds.pairingCode !== "string") return false;
  if (creds.lastPropHash !== undefined && typeof creds.lastPropHash !== "string") return false;
  if (creds.routingInfo !== undefined && !isBytes(creds.routingInfo)) return false;
  return true;
}

function validateSignalValue(type: keyof SignalDataTypeMap, value: unknown): boolean {
  if (type === "pre-key") return isKeyPair(value);
  if (type === "session" || type === "sender-key" || type === "identity-key") return isBytes(value);
  if (type === "lid-mapping") return typeof value === "string";
  if (type === "device-list")
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  if (!isPlainRecord(value)) return false;
  if (type === "sender-key-memory")
    return Object.values(value).every((item) => typeof item === "boolean");
  if (type === "app-state-sync-key") {
    if (!Object.keys(value).every((key) => ["keyData", "fingerprint", "timestamp"].includes(key))) {
      return false;
    }
    const fingerprint = value.fingerprint;
    const validFingerprint =
      fingerprint === undefined ||
      fingerprint === null ||
      (isPlainRecord(fingerprint) &&
        Object.keys(fingerprint).every((key) =>
          ["rawId", "currentIndex", "deviceIndexes"].includes(key)
        ) &&
        (fingerprint.rawId === undefined || isSafeInteger(fingerprint.rawId)) &&
        (fingerprint.currentIndex === undefined || isSafeInteger(fingerprint.currentIndex)) &&
        (fingerprint.deviceIndexes === undefined ||
          (Array.isArray(fingerprint.deviceIndexes) &&
            fingerprint.deviceIndexes.every(isSafeInteger))));
    const timestamp = value.timestamp;
    const validTimestamp =
      timestamp === undefined ||
      timestamp === null ||
      isSafeInteger(timestamp) ||
      (isPlainRecord(timestamp) &&
        hasExactKeys(timestamp, ["low", "high", "unsigned"]) &&
        Number.isInteger(timestamp.low) &&
        Number.isInteger(timestamp.high) &&
        typeof timestamp.unsigned === "boolean");
    return isBytes(value.keyData) && validFingerprint && validTimestamp;
  }
  if (type === "app-state-sync-version") {
    return (
      isSafeInteger(value.version) &&
      isBytes(value.hash) &&
      isPlainRecord(value.indexValueMap) &&
      Object.values(value.indexValueMap).every(
        (entry) =>
          isPlainRecord(entry) && hasExactKeys(entry, ["valueMac"]) && isBytes(entry.valueMac)
      )
    );
  }
  return (
    type === "tctoken" &&
    Object.keys(value).every((key) => ["token", "timestamp", "senderTimestamp"].includes(key)) &&
    isBytes(value.token) &&
    (value.timestamp === undefined || typeof value.timestamp === "string") &&
    (value.senderTimestamp === undefined || isSafeInteger(value.senderTimestamp))
  );
}

function validateSnapshot(value: unknown, accountId: string, authDir: string): PersistedAuthState {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["version", "accountId", "creds", "keys"])) {
    throw authError("WHATSAPP_AUTH_SNAPSHOT_INVALID", "WhatsApp auth snapshot shape is invalid", {
      accountId,
      authDir,
    });
  }
  if (value.version !== AUTH_VERSION) {
    throw authError(
      "WHATSAPP_AUTH_VERSION_UNSUPPORTED",
      "WhatsApp auth snapshot version is unsupported",
      {
        accountId,
        authDir,
        version: value.version,
      }
    );
  }
  if (
    value.accountId !== accountId ||
    !validateCredentials(value.creds) ||
    !isPlainRecord(value.keys)
  ) {
    throw authError(
      "WHATSAPP_AUTH_SNAPSHOT_INVALID",
      "WhatsApp auth snapshot identity or shape is invalid",
      { accountId, authDir }
    );
  }
  for (const [rawType, rawCategory] of Object.entries(value.keys)) {
    if (!SIGNAL_KEY_TYPES.has(rawType as keyof SignalDataTypeMap) || !isPlainRecord(rawCategory)) {
      throw authError(
        "WHATSAPP_AUTH_SNAPSHOT_INVALID",
        "WhatsApp auth snapshot contains an invalid key category",
        { accountId, authDir, keyType: rawType }
      );
    }
    const type = rawType as keyof SignalDataTypeMap;
    for (const [id, item] of Object.entries(rawCategory)) {
      if (id.length === 0 || !validateSignalValue(type, item)) {
        throw authError(
          "WHATSAPP_AUTH_SNAPSHOT_INVALID",
          "WhatsApp auth snapshot contains malformed key material",
          { accountId, authDir, keyType: type, keyId: id }
        );
      }
    }
  }
  return value as unknown as PersistedAuthState;
}

function serializeSnapshot(snapshot: PersistedAuthState): string {
  return JSON.stringify(snapshot, BufferJSON.replacer);
}

function snapshotHash(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex");
}

function commitRecord(accountId: string, state: CommitRecord["state"], hash: string): string {
  return JSON.stringify({ version: AUTH_VERSION, accountId, state, snapshotHash: hash });
}

function validateCommitRecord(
  serialized: string,
  accountId: string,
  authDir: string,
  serializedSnapshot: string
): void {
  let record: unknown;
  try {
    record = JSON.parse(serialized);
  } catch (error) {
    // error-policy:J2 Commit-journal corruption cannot be treated as a healthy snapshot.
    throw authError(
      "WHATSAPP_AUTH_COMMIT_RECORD_CORRUPT",
      "WhatsApp auth commit journal is corrupt",
      { accountId, authDir },
      error
    );
  }
  if (
    !isPlainRecord(record) ||
    !hasExactKeys(record, ["version", "accountId", "state", "snapshotHash"]) ||
    record.version !== AUTH_VERSION ||
    record.accountId !== accountId ||
    typeof record.snapshotHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.snapshotHash)
  ) {
    throw authError(
      "WHATSAPP_AUTH_COMMIT_RECORD_INVALID",
      "WhatsApp auth commit journal shape is invalid",
      { accountId, authDir }
    );
  }
  if (record.state !== "confirmed" || record.snapshotHash !== snapshotHash(serializedSnapshot)) {
    throw authError(
      "WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED",
      "WhatsApp auth snapshot has an unconfirmed or mismatched commit",
      { accountId, authDir, commitState: record.state }
    );
  }
}

async function persistSnapshot(
  authDir: string,
  accountId: string,
  snapshot: PersistedAuthState,
  previousSnapshot: PersistedAuthState | undefined,
  hooks?: BaileysAuthPersistenceHooks
): Promise<void> {
  const serialized = serializeSnapshot(snapshot);
  const hash = snapshotHash(serialized);
  try {
    await atomicWrite(
      authDir,
      COMMIT_FILE,
      commitRecord(accountId, "pending", hash),
      "commit-pending",
      hooks
    );
  } catch (error) {
    if (error instanceof ElizaError && error.code === "WHATSAPP_AUTH_ATOMIC_WRITE_FAILED") {
      throw error;
    }
    throw authError(
      "WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED",
      "WhatsApp auth commit intent has ambiguous durability; reload is required",
      { accountId, authDir, phase: "commit-pending" },
      error
    );
  }

  try {
    await atomicWrite(authDir, SNAPSHOT_FILE, serialized, "snapshot", hooks);
  } catch (error) {
    if (
      previousSnapshot &&
      error instanceof ElizaError &&
      error.code === "WHATSAPP_AUTH_ATOMIC_WRITE_FAILED"
    ) {
      const previousSerialized = serializeSnapshot(previousSnapshot);
      try {
        await atomicWrite(
          authDir,
          COMMIT_FILE,
          commitRecord(accountId, "confirmed", snapshotHash(previousSerialized)),
          "commit-restore",
          hooks
        );
        throw error;
      } catch (restoreError) {
        if (restoreError === error) throw error;
        throw authError(
          "WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED",
          "WhatsApp auth could not durably restore its prior commit after a failed snapshot write",
          { accountId, authDir, phase: "commit-restore" },
          restoreError
        );
      }
    }
    throw authError(
      "WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED",
      "WhatsApp auth snapshot commit is ambiguous; reload is required",
      { accountId, authDir, phase: "snapshot" },
      error
    );
  }

  try {
    await atomicWrite(
      authDir,
      COMMIT_FILE,
      commitRecord(accountId, "confirmed", hash),
      "commit-confirmed",
      hooks
    );
  } catch (error) {
    throw authError(
      "WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED",
      "WhatsApp auth snapshot committed but confirmation failed; reload is required",
      { accountId, authDir, phase: "commit-confirmed" },
      error
    );
  }
}

function cloneSnapshot(
  snapshot: PersistedAuthState,
  accountId: string,
  authDir: string
): PersistedAuthState {
  return validateSnapshot(
    JSON.parse(serializeSnapshot(snapshot), BufferJSON.reviver),
    accountId,
    authDir
  );
}

function assertCurrentGeneration(
  lifecycle: AccountLifecycle,
  generation: number,
  accountId: string,
  authDir: string
): void {
  if (!lifecycle.active || lifecycle.generation !== generation) {
    throw authError(
      "WHATSAPP_AUTH_STATE_RETIRED",
      "This WhatsApp auth state was retired by logout or replacement and cannot be written",
      { accountId, authDir, generation, currentGeneration: lifecycle.generation }
    );
  }
}

export async function loadDurableBaileysAuthState(
  accountId: string,
  configuredAuthDir?: string,
  hooks?: BaileysAuthPersistenceHooks
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; authDir: string }> {
  const authDir = assertAuthoritativeDirectory(accountId, configuredAuthDir);
  return enqueueAccountOperation(authDir, async (lifecycle) => {
    await prepareAccountDirectory(accountId, configuredAuthDir, hooks);
    lifecycle.generation += 1;
    lifecycle.active = true;
    const generation = lifecycle.generation;
    const snapshotPath = path.join(authDir, SNAPSHOT_FILE);
    let snapshot: PersistedAuthState;
    const snapshotStat = await lstatIfPresent(snapshotPath);
    if (!snapshotStat) {
      if (await lstatIfPresent(path.join(authDir, COMMIT_FILE))) {
        throw authError(
          "WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED",
          "WhatsApp auth has a commit journal without a committed snapshot",
          { accountId, authDir }
        );
      }
      snapshot = { version: AUTH_VERSION, accountId, creds: initAuthCreds(), keys: {} };
      await persistSnapshot(authDir, accountId, snapshot, undefined, hooks);
    } else {
      const serializedSnapshot = await readFile(snapshotPath, "utf8");
      const serializedCommit = await readFile(path.join(authDir, COMMIT_FILE), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(serializedSnapshot, BufferJSON.reviver);
      } catch (error) {
        // error-policy:J2 Unparseable committed auth bytes retain their parse or filesystem cause.
        throw authError(
          "WHATSAPP_AUTH_SNAPSHOT_CORRUPT",
          "WhatsApp auth snapshot is corrupt",
          { accountId, authDir },
          error
        );
      }
      snapshot = validateSnapshot(parsed, accountId, authDir);
      validateCommitRecord(serializedCommit, accountId, authDir, serializedSnapshot);
    }
    const liveCreds = cloneSnapshot(snapshot, accountId, authDir).creds;

    const persist = () =>
      enqueueAccountOperation(authDir, async (current) => {
        assertCurrentGeneration(current, generation, accountId, authDir);
        const candidate = cloneSnapshot(snapshot, accountId, authDir);
        candidate.creds = cloneSnapshot(
          { ...candidate, creds: liveCreds },
          accountId,
          authDir
        ).creds;
        try {
          await persistSnapshot(authDir, accountId, candidate, snapshot, hooks);
          snapshot = candidate;
        } catch (error) {
          current.active = false;
          current.generation += 1;
          throw error;
        }
      });

    const keys: AuthenticationState["keys"] = {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        return enqueueAccountOperation(authDir, async (current) => {
          assertCurrentGeneration(current, generation, accountId, authDir);
          const values: { [id: string]: SignalDataTypeMap[T] } = {};
          const category = snapshot.keys[type] as Record<string, SignalDataTypeMap[T]> | undefined;
          for (const id of ids) {
            let value = category?.[id];
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as proto.Message.IAppStateSyncKeyData
              ) as unknown as SignalDataTypeMap[T];
            }
            values[id] = value as SignalDataTypeMap[T];
          }
          return values;
        });
      },
      set: async (data: SignalDataSet) => {
        await enqueueAccountOperation(authDir, async (current) => {
          assertCurrentGeneration(current, generation, accountId, authDir);
          const candidate = cloneSnapshot(snapshot, accountId, authDir);
          for (const type of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            const updates = data[type];
            if (!candidate.keys[type]) candidate.keys[type] = {};
            const category = candidate.keys[type] as Record<string, SignalDataTypeMap[typeof type]>;
            if (!updates) continue;
            for (const [id, value] of Object.entries(updates)) {
              if (value === null || value === undefined) delete category[id];
              else category[id] = value as SignalDataTypeMap[typeof type];
            }
          }
          try {
            await persistSnapshot(authDir, accountId, candidate, snapshot, hooks);
            snapshot = candidate;
          } catch (error) {
            if (
              error instanceof ElizaError &&
              (error.code === "WHATSAPP_AUTH_COMMIT_AMBIGUOUS" ||
                error.code === "WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED")
            ) {
              current.active = false;
              current.generation += 1;
            }
            throw error;
          }
        });
      },
      clear: async () => {
        await enqueueAccountOperation(authDir, async (current) => {
          assertCurrentGeneration(current, generation, accountId, authDir);
          const candidate = cloneSnapshot(snapshot, accountId, authDir);
          candidate.keys = {};
          try {
            await persistSnapshot(authDir, accountId, candidate, snapshot, hooks);
            snapshot = candidate;
          } catch (error) {
            if (
              error instanceof ElizaError &&
              (error.code === "WHATSAPP_AUTH_COMMIT_AMBIGUOUS" ||
                error.code === "WHATSAPP_AUTH_COMMIT_RELOAD_REQUIRED")
            ) {
              current.active = false;
              current.generation += 1;
            }
            throw error;
          }
        });
      },
    };

    return {
      state: { creds: liveCreds, keys },
      saveCreds: persist,
      authDir,
    };
  });
}

export async function removeDurableBaileysAuthState(
  accountId: string,
  hooks?: BaileysAuthPersistenceHooks
): Promise<void> {
  const authDir = resolveWhatsAppAuthDirectory(accountId);
  await enqueueAccountOperation(authDir, async (lifecycle) => {
    if (!(await lstatIfPresent(authDir))) {
      lifecycle.active = false;
      lifecycle.generation += 1;
      return;
    }
    await validateAccountOwnershipForDeletion(accountId, authDir);
    lifecycle.active = false;
    lifecycle.generation += 1;
    try {
      await hooks?.beforeLogoutDelete?.();
      await rm(authDir, { recursive: true });
      await syncDirectory(path.dirname(authDir));
    } catch (error) {
      // error-policy:J2 Logout deletion failures retain the dedicated account path and cause.
      throw authError(
        "WHATSAPP_AUTH_LOGOUT_DELETE_FAILED",
        "Could not remove the dedicated WhatsApp auth directory",
        { accountId, authDir },
        error
      );
    }
    activeAccountPaths.delete(authDir);
  });
}

export async function whatsappDurableAuthExists(accountId: string): Promise<boolean> {
  const authDir = resolveWhatsAppAuthDirectory(accountId);
  return enqueueAccountOperation(authDir, async () => {
    if (!(await lstatIfPresent(authDir))) return false;
    await validateAccountDirectoryReadOnly(accountId, authDir);
    return true;
  });
}

export class BaileysAuthManager {
  private readonly accountId: string;
  private readonly configuredAuthDir?: string;
  private state?: AuthenticationState;
  private saveCreds?: () => Promise<void>;

  constructor(accountId: string, configuredAuthDir?: string) {
    this.accountId = accountId;
    this.configuredAuthDir = configuredAuthDir;
  }

  async initialize(): Promise<AuthenticationState> {
    const result = await loadDurableBaileysAuthState(this.accountId, this.configuredAuthDir);
    this.state = result.state;
    this.saveCreds = result.saveCreds;
    return this.state;
  }

  async save(): Promise<void> {
    if (!this.saveCreds) {
      throw authError(
        "WHATSAPP_AUTH_NOT_INITIALIZED",
        "WhatsApp auth cannot be saved before initialization",
        { accountId: this.accountId }
      );
    }
    await this.saveCreds();
  }
}
