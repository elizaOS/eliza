/**
 * Per-account credential storage.
 *
 * Layout: `<stateDir>/auth/{providerId}/{accountId}.json` (mode 0600,
 * atomic writes). Multiple accounts per provider are supported. Every mutator
 * requires a branded root/owner policy; isolated policies are physically
 * confined to the OS temporary directory and no operation may cross its
 * canonical provider directory. Records persist as versioned AES-GCM
 * envelopes encrypted with the vault master key; legacy plaintext records
 * are validated and re-encrypted atomically on first read.
 */

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError, logger, resolveStateDir } from "@elizaos/core";
import { decrypt, encrypt, loadDefaultMasterKeySync } from "@elizaos/vault";
import {
  ACCOUNT_CREDENTIAL_PROVIDER_IDS,
  type AccountCredentialProvider,
  type OAuthCredentials,
} from "./types.ts";

export interface AccountCredentialRecord {
  /** accountId, e.g. "default" or a uuid */
  id: string;
  providerId: AccountCredentialProvider;
  /** user-facing name (e.g. "Personal", "Work") */
  label: string;
  source: "oauth" | "api-key";
  /**
   * Existing OAuth credential blob — `{ access, refresh, expires }`
   * for OAuth accounts; for `api-key` accounts only `access` is
   * meaningful (refresh is the empty string and expires is `0` /
   * a distant-expiry sentinel by convention of the caller).
   */
  credentials: OAuthCredentials;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  organizationId?: string;
  userId?: string;
  email?: string;
}

export type AccountStorageOwner = "runtime" | "isolated-test";

const ACCOUNT_STORAGE_POLICY: unique symbol = Symbol("account-storage-policy");
const ACCOUNT_STORAGE_ROOT_IDENTITY: unique symbol = Symbol(
  "account-storage-root-identity",
);

interface AccountStorageRootIdentity {
  dev: number;
  generation: number;
  ino: number;
}

export interface AccountStoragePolicy {
  readonly stateRoot: string;
  readonly authRoot: string;
  readonly owner: AccountStorageOwner;
  readonly [ACCOUNT_STORAGE_POLICY]: true;
  readonly [ACCOUNT_STORAGE_ROOT_IDENTITY]: AccountStorageRootIdentity;
}

interface PlannedAccountDeletion {
  accountId: string;
  contents?: Buffer;
  file: string;
  mode?: number;
  provider: AccountCredentialProvider;
  stat?: Pick<fs.Stats, "dev" | "ino" | "mtimeMs" | "size">;
}

type ExistingPlannedAccountDeletion = PlannedAccountDeletion & {
  contents: Buffer;
  mode: number;
  stat: NonNullable<PlannedAccountDeletion["stat"]>;
};

const ACCOUNT_DELETION_PLAN: unique symbol = Symbol("account-deletion-plan");

export interface AccountDeletionPlan {
  readonly policy: AccountStoragePolicy;
  readonly targets: readonly PlannedAccountDeletion[];
  readonly providerInventory?: readonly AccountCredentialProvider[];
  readonly [ACCOUNT_DELETION_PLAN]: true;
}

interface StorageLock {
  lockDir: string;
  ownerFile: string;
  policy: AccountStoragePolicy;
  token: string;
}

interface PlannedResetFile {
  contents: Buffer;
  file: string;
  mode: number;
  stat: Pick<fs.Stats, "dev" | "ino" | "mtimeMs" | "size">;
}

interface CredentialResetPlan {
  directories: readonly string[];
  files: readonly PlannedResetFile[];
}

const STORAGE_LOCK_DIRECTORY = ".credential-storage.lock";
const STORAGE_LOCK_OWNER_FILE = "owner.json";
const STORAGE_GENERATION_FILE = ".credential-storage-generation";
const STORAGE_LOCK_WAIT_MS = 20;
const STORAGE_LOCK_TIMEOUT_MS = 15_000;
const STORAGE_LOCK_STALE_MS = 120_000;

function storageError(
  code: string,
  message: string,
  context: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    context,
    severity: "fatal",
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isPathAtOrWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function resolvePhysicalPath(target: string): string {
  let existingAncestor = path.resolve(target);
  const missingSegments: string[] = [];

  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      return path.resolve(target);
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  return path.resolve(
    fs.realpathSync.native(existingAncestor),
    ...missingSegments,
  );
}

function assertContained(
  parent: string,
  target: string,
  operation: string,
): void {
  const lexicalParent = path.resolve(parent);
  const lexicalTarget = path.resolve(target);
  const physicalParent = resolvePhysicalPath(lexicalParent);
  const physicalTarget = resolvePhysicalPath(lexicalTarget);
  if (
    !isPathAtOrWithin(lexicalParent, lexicalTarget) ||
    !isPathAtOrWithin(physicalParent, physicalTarget)
  ) {
    throw storageError(
      "AUTH_CREDENTIAL_PATH_ESCAPE",
      `Credential ${operation} target escapes its canonical storage directory`,
      {
        operation,
        parent: lexicalParent,
        target: lexicalTarget,
        physicalParent,
        physicalTarget,
      },
    );
  }
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
}

function assertRegularDirectory(
  directory: string,
  operation: string,
): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (cause) {
    throw storageError(
      "AUTH_CREDENTIAL_STORAGE_ROOT_CHANGED",
      `Credential ${operation} directory is unavailable`,
      { directory, operation },
      cause,
    );
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw storageError(
      "AUTH_CREDENTIAL_PATH_ESCAPE",
      `Credential ${operation} directory must be a real directory`,
      { directory, operation },
    );
  }
  return stat;
}

function readGenerationFile(authRoot: string): number {
  const generationFile = path.join(authRoot, STORAGE_GENERATION_FILE);
  if (!fs.existsSync(generationFile)) return 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      generationFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw storageError(
        "AUTH_CREDENTIAL_GENERATION_INVALID",
        "Credential storage generation is not a regular file",
        { generationFile },
      );
    }
    const raw = fs.readFileSync(descriptor, "utf8").trim();
    if (!/^\d+$/.test(raw)) {
      throw storageError(
        "AUTH_CREDENTIAL_GENERATION_INVALID",
        "Credential storage generation is malformed",
        { generationFile },
      );
    }
    const generation = Number(raw);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw storageError(
        "AUTH_CREDENTIAL_GENERATION_INVALID",
        "Credential storage generation is outside the supported range",
        { generationFile, generation: raw },
      );
    }
    return generation;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ELOOP") {
      throw storageError(
        "AUTH_CREDENTIAL_PATH_ESCAPE",
        "Credential storage generation cannot be a symbolic link",
        { generationFile },
        cause,
      );
    }
    throw cause;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensureAuthRoot(policy: AccountStoragePolicy): void {
  assertStoragePolicy(policy);
  fs.mkdirSync(policy.authRoot, { recursive: true, mode: 0o700 });
  assertStoragePolicy(policy);
  assertContained(policy.stateRoot, policy.authRoot, "auth-directory");
  assertRegularDirectory(policy.authRoot, "auth");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLockOwner(
  ownerFile: string,
): { pid: number; token: string } | null {
  try {
    const descriptor = fs.openSync(
      ownerFile,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) return null;
      let value: unknown;
      try {
        value = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      } catch {
        // error-policy:J3 another process may observe the owner file between
        // its exclusive creation and durable JSON write; the directory age
        // determines whether an ownerless lock is reclaimable.
        return null;
      }
      if (!value || typeof value !== "object") return null;
      const owner = value as Record<string, unknown>;
      return Number.isSafeInteger(owner.pid) && typeof owner.token === "string"
        ? { pid: owner.pid as number, token: owner.token }
        : null;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

function removeStaleLock(
  policy: AccountStoragePolicy,
  lockDir: string,
): boolean {
  const stat = fs.lstatSync(lockDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw storageError(
      "AUTH_CREDENTIAL_PATH_ESCAPE",
      "Credential storage lock cannot be a symbolic link or non-directory",
      { lockDir },
    );
  }
  const owner = readLockOwner(path.join(lockDir, STORAGE_LOCK_OWNER_FILE));
  const expired = Date.now() - stat.mtimeMs >= STORAGE_LOCK_STALE_MS;
  if (owner && processIsAlive(owner.pid)) return false;
  if (!owner && !expired) return false;

  const quarantine = `${lockDir}.stale.${process.pid}.${randomUUID()}`;
  assertContained(policy.authRoot, quarantine, "stale-lock-quarantine");
  try {
    fs.renameSync(lockDir, quarantine);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw cause;
  }
  fs.rmSync(quarantine, { recursive: true, force: false });
  fsyncDirectory(policy.authRoot);
  return true;
}

function acquireStorageLock(
  policy: AccountStoragePolicy,
  operation: string,
): StorageLock {
  ensureAuthRoot(policy);
  const lockDir = path.join(policy.authRoot, STORAGE_LOCK_DIRECTORY);
  const ownerFile = path.join(lockDir, STORAGE_LOCK_OWNER_FILE);
  assertContained(policy.authRoot, lockDir, "storage-lock");
  const startedAt = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      const token = randomUUID();
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(
          ownerFile,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        fs.writeFileSync(
          descriptor,
          JSON.stringify({ operation, pid: process.pid, token }),
          "utf8",
        );
        fs.fsyncSync(descriptor);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
      fsyncDirectory(lockDir);
      fsyncDirectory(policy.authRoot);
      assertStoragePolicy(policy);
      const currentGeneration = readGenerationFile(policy.authRoot);
      const policyGeneration = policy[ACCOUNT_STORAGE_ROOT_IDENTITY].generation;
      if (currentGeneration !== policyGeneration) {
        fs.unlinkSync(ownerFile);
        fs.rmdirSync(lockDir);
        fsyncDirectory(policy.authRoot);
        throw storageError(
          "AUTH_CREDENTIAL_STORAGE_GENERATION_CHANGED",
          "Credential storage policy predates the latest reset",
          { currentGeneration, operation, policyGeneration },
        );
      }
      return { lockDir, ownerFile, policy, token };
    } catch (cause) {
      const errorCode = (cause as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") {
        // error-policy:J2 The auth root vanished between lock creation and
        // the generation check — a concurrent full reset removed it. The
        // fence held (nothing was written); surface the typed generation
        // error the reset contract promises instead of the raw ENOENT.
        throw storageError(
          "AUTH_CREDENTIAL_STORAGE_GENERATION_CHANGED",
          "Credential storage policy predates the latest reset",
          {
            operation,
            policyGeneration: policy[ACCOUNT_STORAGE_ROOT_IDENTITY].generation,
          },
          cause,
        );
      }
      if (errorCode !== "EEXIST") throw cause;
      if (removeStaleLock(policy, lockDir)) continue;
      if (Date.now() - startedAt >= STORAGE_LOCK_TIMEOUT_MS) {
        throw storageError(
          "AUTH_CREDENTIAL_STORAGE_LOCK_TIMEOUT",
          "Timed out waiting for the credential storage lock",
          { lockDir, operation, timeoutMs: STORAGE_LOCK_TIMEOUT_MS },
          cause,
        );
      }
      sleepSync(STORAGE_LOCK_WAIT_MS);
      assertStoragePolicy(policy);
    }
  }
}

function releaseStorageLock(lock: StorageLock): void {
  assertStoragePolicy(lock.policy);
  const owner = readLockOwner(lock.ownerFile);
  if (!owner || owner.pid !== process.pid || owner.token !== lock.token) {
    throw storageError(
      "AUTH_CREDENTIAL_STORAGE_LOCK_OWNERSHIP_LOST",
      "Credential storage lock ownership changed before release",
      { lockDir: lock.lockDir },
    );
  }
  const entries = fs.readdirSync(lock.lockDir);
  if (entries.length !== 1 || entries[0] !== STORAGE_LOCK_OWNER_FILE) {
    throw storageError(
      "AUTH_CREDENTIAL_STORAGE_LOCK_OWNERSHIP_LOST",
      "Credential storage lock contains unexpected entries",
      { entries, lockDir: lock.lockDir },
    );
  }
  fs.unlinkSync(lock.ownerFile);
  fs.rmdirSync(lock.lockDir);
  fsyncDirectory(lock.policy.authRoot);
}

function withStorageLock<T>(
  policy: AccountStoragePolicy,
  operation: string,
  callback: () => T,
): T {
  const lock = acquireStorageLock(policy, operation);
  let result: T;
  try {
    result = callback();
  } catch (cause) {
    try {
      releaseStorageLock(lock);
    } catch (releaseError) {
      throw storageError(
        "AUTH_CREDENTIAL_STORAGE_LOCK_RELEASE_FAILED",
        "Credential operation failed and its storage lock could not be released",
        { operation, releaseError: String(releaseError) },
        cause,
      );
    }
    throw cause;
  }
  releaseStorageLock(lock);
  return result;
}

function createAccountStoragePolicy(
  stateRoot: string,
  owner: AccountStorageOwner,
): AccountStoragePolicy {
  if (!stateRoot.trim() || !path.isAbsolute(stateRoot)) {
    throw storageError(
      "AUTH_CREDENTIAL_STORAGE_POLICY_INVALID",
      "Account storage policy requires an absolute state root",
      { owner, stateRoot },
    );
  }

  const canonicalStateRoot = resolvePhysicalPath(stateRoot);
  fs.mkdirSync(canonicalStateRoot, { recursive: true, mode: 0o700 });
  const stateRootStat = assertRegularDirectory(
    canonicalStateRoot,
    "state-root",
  );
  if (owner === "isolated-test") {
    const canonicalTempRoot = fs.realpathSync.native(tmpdir());
    if (
      canonicalStateRoot === canonicalTempRoot ||
      !isPathAtOrWithin(canonicalTempRoot, canonicalStateRoot)
    ) {
      throw storageError(
        "AUTH_CREDENTIAL_ISOLATED_ROOT_REQUIRED",
        "Isolated account storage must resolve beneath the OS temporary directory",
        {
          owner,
          stateRoot: path.resolve(stateRoot),
          physicalStateRoot: canonicalStateRoot,
          temporaryRoot: canonicalTempRoot,
        },
      );
    }
  }

  const authRoot = path.join(canonicalStateRoot, "auth");
  let generation = 0;
  if (fs.existsSync(authRoot)) {
    assertContained(canonicalStateRoot, authRoot, "auth-directory");
    assertRegularDirectory(authRoot, "auth");
    generation = readGenerationFile(authRoot);
  }
  return Object.freeze({
    stateRoot: canonicalStateRoot,
    authRoot,
    owner,
    [ACCOUNT_STORAGE_POLICY]: true as const,
    [ACCOUNT_STORAGE_ROOT_IDENTITY]: Object.freeze({
      dev: stateRootStat.dev,
      generation,
      ino: stateRootStat.ino,
    }),
  });
}

export function createRuntimeAccountStoragePolicy(
  stateRoot: string,
): AccountStoragePolicy {
  return createAccountStoragePolicy(stateRoot, "runtime");
}

export function createIsolatedAccountStoragePolicy(
  stateRoot: string,
): AccountStoragePolicy {
  return createAccountStoragePolicy(stateRoot, "isolated-test");
}

function defaultReadPolicy(): AccountStoragePolicy {
  return createRuntimeAccountStoragePolicy(resolveStateDir());
}

function assertStoragePolicy(policy: AccountStoragePolicy): void {
  if (policy?.[ACCOUNT_STORAGE_POLICY] !== true) {
    throw storageError(
      "AUTH_CREDENTIAL_STORAGE_POLICY_INVALID",
      "Credential operation requires a policy created by account-storage",
      {},
    );
  }
  const rootIdentity = policy[ACCOUNT_STORAGE_ROOT_IDENTITY];
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(policy.stateRoot);
  } catch (cause) {
    throw storageError(
      "AUTH_CREDENTIAL_STORAGE_ROOT_CHANGED",
      "Account storage root is no longer accessible",
      { stateRoot: policy.stateRoot },
      cause,
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw storageError(
      "AUTH_CREDENTIAL_STORAGE_ROOT_CHANGED",
      "Account storage root is no longer the directory owned by this policy",
      { stateRoot: policy.stateRoot },
    );
  }
  const physicalStateRoot = resolvePhysicalPath(policy.stateRoot);
  if (
    physicalStateRoot !== policy.stateRoot ||
    rootStat.dev !== rootIdentity.dev ||
    rootStat.ino !== rootIdentity.ino
  ) {
    throw storageError(
      "AUTH_CREDENTIAL_STORAGE_ROOT_CHANGED",
      "Account storage root changed after policy creation",
      {
        stateRoot: policy.stateRoot,
        physicalStateRoot,
        expectedDev: rootIdentity.dev,
        expectedIno: rootIdentity.ino,
        actualDev: rootStat.dev,
        actualIno: rootStat.ino,
      },
    );
  }
  assertContained(policy.stateRoot, policy.authRoot, "policy");
  if (policy.owner === "isolated-test") {
    const canonicalTempRoot = fs.realpathSync.native(tmpdir());
    if (!isPathAtOrWithin(canonicalTempRoot, policy.stateRoot)) {
      throw storageError(
        "AUTH_CREDENTIAL_ISOLATED_ROOT_REQUIRED",
        "Isolated account storage no longer resolves beneath the OS temporary directory",
        { stateRoot: policy.stateRoot, temporaryRoot: canonicalTempRoot },
      );
    }
  }
}

interface EncryptedAccountEnvelope {
  schemaVersion: 2;
  ciphertext: string;
}

function isEnvelope(value: unknown): value is EncryptedAccountEnvelope {
  const candidate = value as Partial<EncryptedAccountEnvelope> | null;
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    candidate.schemaVersion === 2 &&
    typeof candidate.ciphertext === "string"
  );
}

function accountAad(
  provider: AccountCredentialProvider,
  accountId: string,
): string {
  return `@elizaos/auth/account/${provider}/${accountId}`;
}

/**
 * Test processes and isolated-test policies never touch the real vault master
 * key: each isolated auth root gets its own ephemeral in-process key, so a
 * test cannot decrypt (or corrupt) developer credentials even if pointed at a
 * real state directory by mistake.
 */
const testKeys = new Map<string, Buffer>();

function isTestProcess(): boolean {
  const argv = process.argv.join(" ").toLowerCase();
  return (
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true" ||
    process.env.BUN_ENV === "test" ||
    argv.includes("vitest") ||
    argv.includes("bun test")
  );
}

function masterKey(policy: AccountStoragePolicy): Buffer {
  if (policy.owner !== "isolated-test" && !isTestProcess()) {
    return loadDefaultMasterKeySync();
  }
  const root = path.resolve(policy.authRoot);
  const existing = testKeys.get(root);
  if (existing) return existing;
  const created = randomBytes(32);
  testKeys.set(root, created);
  return created;
}

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export function assertCanonicalAccountId(accountId: string): void {
  if (
    typeof accountId !== "string" ||
    !ACCOUNT_ID_PATTERN.test(accountId) ||
    accountId.includes("..") ||
    path.isAbsolute(accountId) ||
    path.win32.isAbsolute(accountId)
  ) {
    throw storageError(
      "AUTH_CREDENTIAL_ACCOUNT_ID_INVALID",
      "Account id must be a canonical filename-safe identifier",
      { accountId: String(accountId).slice(0, 160) },
    );
  }
}

function providerDir(
  provider: AccountCredentialProvider,
  policy: AccountStoragePolicy,
): string {
  assertStoragePolicy(policy);
  if (fs.existsSync(policy.authRoot)) {
    assertRegularDirectory(policy.authRoot, "auth");
  }
  const dir = path.resolve(policy.authRoot, provider);
  assertContained(policy.authRoot, dir, "provider-directory");
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
    throw storageError(
      "AUTH_CREDENTIAL_PATH_ESCAPE",
      "Credential provider directory cannot be a symbolic link",
      { dir, provider },
    );
  }
  return dir;
}

function accountFile(
  provider: AccountCredentialProvider,
  accountId: string,
  policy: AccountStoragePolicy,
): string {
  assertCanonicalAccountId(accountId);
  const dir = providerDir(provider, policy);
  const file = path.resolve(dir, `${accountId}.json`);
  assertContained(dir, file, "account-file");
  return file;
}

function ensureProviderDir(
  provider: AccountCredentialProvider,
  policy: AccountStoragePolicy,
): string {
  assertStoragePolicy(policy);
  fs.mkdirSync(policy.authRoot, { recursive: true, mode: 0o700 });
  assertContained(policy.stateRoot, policy.authRoot, "auth-directory");
  if (fs.lstatSync(policy.authRoot).isSymbolicLink()) {
    throw storageError(
      "AUTH_CREDENTIAL_PATH_ESCAPE",
      "Credential auth directory cannot be a symbolic link",
      { authRoot: policy.authRoot },
    );
  }
  const dir = providerDir(provider, policy);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertContained(policy.authRoot, dir, "provider-directory");
  fsyncDirectory(policy.authRoot);
  return dir;
}

function writeAccountFile(
  provider: AccountCredentialProvider,
  accountId: string,
  policy: AccountStoragePolicy,
  value: AccountCredentialRecord,
): void {
  const dir = providerDir(provider, policy);
  const file = accountFile(provider, accountId, policy);
  const temporaryFile = path.join(
    dir,
    `.${accountId}.${process.pid}.${randomUUID()}.tmp`,
  );
  assertContained(dir, temporaryFile, "temporary-account-file");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporaryFile,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    const envelope: EncryptedAccountEnvelope = {
      schemaVersion: 2,
      ciphertext: encrypt(
        masterKey(policy),
        JSON.stringify(value),
        accountAad(provider, accountId),
      ),
    };
    fs.writeFileSync(descriptor, JSON.stringify(envelope, null, 2), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertStoragePolicy(policy);
    assertContained(dir, temporaryFile, "temporary-account-file");
    assertContained(dir, file, "account-file");
    fs.renameSync(temporaryFile, file);
    fsyncDirectory(dir);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryFile)) {
      const stat = fs.lstatSync(temporaryFile);
      if (!stat.isSymbolicLink()) fs.rmSync(temporaryFile, { force: true });
    }
  }
}

function statMatches(
  actual: Pick<fs.Stats, "dev" | "ino" | "mtimeMs" | "size">,
  expected: NonNullable<PlannedAccountDeletion["stat"]>,
): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs
  );
}

function readRegularFileNoFollow(
  file: string,
  policy: AccountStoragePolicy,
  operation: string,
): { contents: Buffer; stat: fs.Stats } {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw storageError(
        "AUTH_CREDENTIAL_TARGET_NOT_REGULAR_FILE",
        `Credential ${operation} target is not a regular file`,
        { file, operation },
      );
    }
    assertStoragePolicy(policy);
    const pathStat = fs.lstatSync(file);
    if (
      pathStat.isSymbolicLink() ||
      pathStat.dev !== stat.dev ||
      pathStat.ino !== stat.ino
    ) {
      throw storageError(
        "AUTH_CREDENTIAL_PATH_ESCAPE",
        `Credential ${operation} target changed while it was opened`,
        { file, operation },
      );
    }
    return { contents: fs.readFileSync(descriptor), stat };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ELOOP") {
      throw storageError(
        "AUTH_CREDENTIAL_PATH_ESCAPE",
        `Credential ${operation} target cannot be a symbolic link`,
        { file, operation },
        cause,
      );
    }
    throw cause;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function preflightAccountDeletionsUnlocked(
  accounts: readonly {
    provider: AccountCredentialProvider;
    accountId: string;
  }[],
  policy: AccountStoragePolicy,
): AccountDeletionPlan {
  assertStoragePolicy(policy);
  const targets: PlannedAccountDeletion[] = [];
  const seen = new Set<string>();

  for (const { provider, accountId } of accounts) {
    const file = accountFile(provider, accountId, policy);
    if (seen.has(file)) continue;
    seen.add(file);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) {
        throw storageError(
          "AUTH_CREDENTIAL_TARGET_NOT_REGULAR_FILE",
          "Credential deletion target is not a regular file",
          { accountId, file, provider },
        );
      }
      targets.push({
        accountId,
        contents: fs.readFileSync(descriptor),
        file,
        mode: stat.mode & 0o777,
        provider,
        stat: {
          dev: stat.dev,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        targets.push({ accountId, file, provider });
        continue;
      }
      if ((error as NodeJS.ErrnoException).code === "ELOOP") {
        throw storageError(
          "AUTH_CREDENTIAL_TARGET_NOT_REGULAR_FILE",
          "Credential deletion target cannot be a symbolic link",
          { accountId, file, provider },
          error,
        );
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  return Object.freeze({
    policy,
    targets: Object.freeze(targets),
    [ACCOUNT_DELETION_PLAN]: true as const,
  });
}

function listProviderCredentialFilesUnlocked(
  providers: readonly AccountCredentialProvider[],
  policy: AccountStoragePolicy,
): string[] {
  const files: string[] = [];
  for (const provider of providers) {
    const dir = providerDir(provider, policy);
    if (!fs.existsSync(dir)) continue;
    assertRegularDirectory(dir, "provider");
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      if (entry.endsWith(".tmp.json") || entry.endsWith(".json.tmp")) continue;
      const accountId = entry.slice(0, -".json".length);
      assertCanonicalAccountId(accountId);
      files.push(accountFile(provider, accountId, policy));
    }
  }
  return files.sort();
}

function preflightProviderAccountDeletionsUnlocked(
  providers: readonly AccountCredentialProvider[],
  policy: AccountStoragePolicy,
): AccountDeletionPlan {
  assertStoragePolicy(policy);
  const accounts: Array<{
    provider: AccountCredentialProvider;
    accountId: string;
  }> = [];
  for (const provider of providers) {
    const dir = providerDir(provider, policy);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.endsWith(".json")) continue;
      if (entry.endsWith(".tmp.json") || entry.endsWith(".json.tmp")) continue;
      const accountId = entry.slice(0, -".json".length);
      assertCanonicalAccountId(accountId);
      accounts.push({ provider, accountId });
    }
  }
  const plan = preflightAccountDeletionsUnlocked(accounts, policy);
  return Object.freeze({
    ...plan,
    providerInventory: Object.freeze([...providers]),
  });
}

function commitAccountDeletionsUnlocked(plan: AccountDeletionPlan): number {
  if (plan?.[ACCOUNT_DELETION_PLAN] !== true) {
    throw storageError(
      "AUTH_CREDENTIAL_DELETE_PLAN_INVALID",
      "Credential deletion requires a preflighted plan",
      {},
    );
  }
  assertStoragePolicy(plan.policy);

  if (plan.providerInventory) {
    const currentFiles = listProviderCredentialFilesUnlocked(
      plan.providerInventory,
      plan.policy,
    );
    const plannedFiles = plan.targets
      .filter((target) => target.stat !== undefined)
      .map((target) => target.file)
      .sort();
    if (
      currentFiles.length !== plannedFiles.length ||
      currentFiles.some((file, index) => file !== plannedFiles[index])
    ) {
      throw storageError(
        "AUTH_CREDENTIAL_DELETE_INVENTORY_CHANGED",
        "Credential inventory changed after deletion preflight",
        { currentFiles, plannedFiles },
      );
    }
  }

  const existingTargets = plan.targets.filter(
    (target): target is ExistingPlannedAccountDeletion =>
      target.stat !== undefined &&
      target.contents !== undefined &&
      target.mode !== undefined,
  );
  for (const target of existingTargets) {
    const currentFile = accountFile(
      target.provider,
      target.accountId,
      plan.policy,
    );
    if (currentFile !== target.file) {
      throw storageError(
        "AUTH_CREDENTIAL_DELETE_TARGET_CHANGED",
        "Credential deletion target changed after preflight",
        { currentFile, plannedFile: target.file },
      );
    }
    const stat = fs.lstatSync(target.file);
    if (stat.isSymbolicLink() || !statMatches(stat, target.stat)) {
      throw storageError(
        "AUTH_CREDENTIAL_DELETE_TARGET_CHANGED",
        "Credential deletion target changed after preflight",
        { accountId: target.accountId, file: target.file },
      );
    }
  }

  const deleted: ExistingPlannedAccountDeletion[] = [];
  try {
    for (const target of existingTargets) {
      fs.unlinkSync(target.file);
      deleted.push(target);
    }
    for (const directory of new Set(
      existingTargets.map((target) => path.dirname(target.file)),
    )) {
      fsyncDirectory(directory);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const target of deleted.reverse()) {
      try {
        const descriptor = fs.openSync(
          target.file,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          target.mode,
        );
        try {
          fs.writeFileSync(descriptor, target.contents);
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        fsyncDirectory(path.dirname(target.file));
      } catch (rollbackError) {
        rollbackFailures.push(
          `${target.file}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    throw storageError(
      "AUTH_CREDENTIAL_DELETE_TRANSACTION_FAILED",
      "Credential deletion failed and was rolled back",
      { deleted: deleted.length, rollbackFailures },
      error,
    );
  }
  return deleted.length;
}

export function preflightAccountDeletions(
  accounts: readonly {
    provider: AccountCredentialProvider;
    accountId: string;
  }[],
  policy: AccountStoragePolicy,
): AccountDeletionPlan {
  return withStorageLock(policy, "preflight-account-deletions", () =>
    preflightAccountDeletionsUnlocked(accounts, policy),
  );
}

export function preflightProviderAccountDeletions(
  providers: readonly AccountCredentialProvider[],
  policy: AccountStoragePolicy,
): AccountDeletionPlan {
  return withStorageLock(policy, "preflight-provider-deletions", () =>
    preflightProviderAccountDeletionsUnlocked(providers, policy),
  );
}

export function commitAccountDeletions(plan: AccountDeletionPlan): number {
  if (plan?.[ACCOUNT_DELETION_PLAN] !== true) {
    throw storageError(
      "AUTH_CREDENTIAL_DELETE_PLAN_INVALID",
      "Credential deletion requires a preflighted plan",
      {},
    );
  }
  return withStorageLock(plan.policy, "commit-account-deletions", () =>
    commitAccountDeletionsUnlocked(plan),
  );
}

function isAccountCredentialRecord(
  value: unknown,
): value is AccountCredentialRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const credentials =
    v.credentials && typeof v.credentials === "object"
      ? (v.credentials as Record<string, unknown>)
      : null;
  const finiteTimestamp = (candidate: unknown) =>
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0;
  const optionalString = (candidate: unknown) =>
    candidate === undefined || typeof candidate === "string";
  return (
    typeof v.id === "string" &&
    typeof v.providerId === "string" &&
    (ACCOUNT_CREDENTIAL_PROVIDER_IDS as readonly string[]).includes(
      v.providerId,
    ) &&
    typeof v.label === "string" &&
    v.label.length > 0 &&
    (v.source === "oauth" || v.source === "api-key") &&
    credentials !== null &&
    typeof credentials.access === "string" &&
    credentials.access.length > 0 &&
    typeof credentials.refresh === "string" &&
    finiteTimestamp(credentials.expires) &&
    optionalString(credentials.idToken) &&
    finiteTimestamp(v.createdAt) &&
    finiteTimestamp(v.updatedAt) &&
    (v.lastUsedAt === undefined || finiteTimestamp(v.lastUsedAt)) &&
    optionalString(v.organizationId) &&
    optionalString(v.userId) &&
    optionalString(v.email)
  );
}

interface DecodedAccountRecord {
  record: AccountCredentialRecord;
  wasPlaintext: boolean;
}

/**
 * Decode raw account-file bytes into a validated record. Envelope files are
 * decrypted with the policy-scoped master key and a per-provider/account AAD
 * so a ciphertext cannot be replayed under a different identity; legacy
 * plaintext files are accepted once and flagged for re-encryption. Any
 * decrypt or schema failure throws — a credential that cannot be proven
 * intact is never returned.
 */
function decodeAccountRecord(
  contents: Buffer,
  file: string,
  provider: AccountCredentialProvider,
  policy: AccountStoragePolicy,
): DecodedAccountRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch (cause) {
    throw storageError(
      "AUTH_CREDENTIAL_RECORD_CORRUPT",
      "Credential record contains malformed JSON",
      { file },
      cause,
    );
  }
  if (!isEnvelope(parsed)) {
    return {
      record: parseAccountCredentialRecord(parsed, file),
      wasPlaintext: true,
    };
  }
  let decrypted: unknown;
  try {
    decrypted = JSON.parse(
      decrypt(
        masterKey(policy),
        parsed.ciphertext,
        accountAad(provider, path.basename(file, ".json")),
      ),
    );
  } catch (cause) {
    throw storageError(
      "AUTH_CREDENTIAL_RECORD_CORRUPT",
      "Credential envelope failed authenticated decryption",
      { file, provider },
      cause,
    );
  }
  return {
    record: parseAccountCredentialRecord(decrypted, file),
    wasPlaintext: false,
  };
}

function parseAccountCredentialRecord(
  parsed: unknown,
  file: string,
): AccountCredentialRecord {
  if (!isAccountCredentialRecord(parsed)) {
    throw storageError(
      "AUTH_CREDENTIAL_RECORD_CORRUPT",
      "Credential record does not match the complete persisted schema",
      { file },
    );
  }
  try {
    assertCanonicalAccountId(parsed.id);
  } catch (cause) {
    throw storageError(
      "AUTH_CREDENTIAL_RECORD_CORRUPT",
      "Credential record contains a non-canonical account id",
      { file },
      cause,
    );
  }
  return parsed;
}

function listAccountsUnlocked(
  provider: AccountCredentialProvider,
  policy: AccountStoragePolicy,
): AccountCredentialRecord[] {
  assertStoragePolicy(policy);
  const dir = providerDir(provider, policy);
  if (!fs.existsSync(dir)) return [];
  assertContained(policy.authRoot, dir, "list-provider-directory");
  assertRegularDirectory(dir, "list-provider");

  const entries = fs.readdirSync(dir);
  const records: AccountCredentialRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (entry.endsWith(".tmp.json") || entry.endsWith(".json.tmp")) continue;
    const filePath = path.join(dir, entry);
    assertContained(dir, filePath, "list-account-file");
    const { contents } = readRegularFileNoFollow(
      filePath,
      policy,
      "list-account",
    );
    const { record: parsed, wasPlaintext } = decodeAccountRecord(
      contents,
      filePath,
      provider,
      policy,
    );
    if (parsed.providerId !== provider) {
      throw storageError(
        "AUTH_CREDENTIAL_RECORD_CORRUPT",
        "Credential record provider does not match its directory",
        {
          actualProvider: parsed.providerId,
          expectedProvider: provider,
          filePath,
        },
      );
    }
    if (`${parsed.id}.json` !== entry) {
      throw storageError(
        "AUTH_CREDENTIAL_RECORD_CORRUPT",
        "Credential record id does not match its filename",
        { accountId: parsed.id, entry, filePath },
      );
    }
    if (wasPlaintext) migratePlaintextRecord(parsed, policy);
    records.push(parsed);
  }

  records.sort((a, b) => {
    const aTime = Number.isFinite(a.createdAt) ? a.createdAt : 0;
    const bTime = Number.isFinite(b.createdAt) ? b.createdAt : 0;
    return aTime - bTime;
  });
  return records;
}

function loadAccountUnlocked(
  provider: AccountCredentialProvider,
  accountId: string,
  policy: AccountStoragePolicy,
): AccountCredentialRecord | null {
  assertStoragePolicy(policy);
  const file = accountFile(provider, accountId, policy);
  let contents: Buffer;
  try {
    contents = readRegularFileNoFollow(file, policy, "load-account").contents;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
  const { record: parsed, wasPlaintext } = decodeAccountRecord(
    contents,
    file,
    provider,
    policy,
  );
  if (parsed.providerId !== provider || parsed.id !== accountId) {
    throw storageError(
      "AUTH_CREDENTIAL_RECORD_CORRUPT",
      "Credential record provider or account id does not match its path",
      {
        accountId,
        actualAccountId: parsed.id,
        actualProvider: parsed.providerId,
        file,
        provider,
      },
    );
  }
  if (wasPlaintext) migratePlaintextRecord(parsed, policy);
  return parsed;
}

/**
 * Re-persist a legacy plaintext record as an encrypted envelope in place.
 * Runs inside the caller's storage lock; the rewrite is the same atomic
 * temp-file + rename path every mutation uses.
 */
function migratePlaintextRecord(
  record: AccountCredentialRecord,
  policy: AccountStoragePolicy,
): void {
  writeAccountFile(record.providerId, record.id, policy, record);
  logger.info(
    `[auth] Migrated ${record.providerId} account "${record.id}" to encrypted storage`,
  );
}

export function listAccounts(
  provider: AccountCredentialProvider,
  policy: AccountStoragePolicy = defaultReadPolicy(),
): AccountCredentialRecord[] {
  return withStorageLock(policy, "list-accounts", () =>
    listAccountsUnlocked(provider, policy),
  );
}

export function loadAccount(
  provider: AccountCredentialProvider,
  accountId: string,
  policy: AccountStoragePolicy = defaultReadPolicy(),
): AccountCredentialRecord | null {
  assertCanonicalAccountId(accountId);
  return withStorageLock(policy, "load-account", () =>
    loadAccountUnlocked(provider, accountId, policy),
  );
}

function collectResetDirectory(
  directory: string,
  policy: AccountStoragePolicy,
  files: PlannedResetFile[],
  directories: string[],
): void {
  assertContained(policy.authRoot, directory, "reset-directory");
  assertRegularDirectory(directory, "reset");
  directories.push(directory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    assertContained(directory, target, "reset-artifact");
    if (entry.isSymbolicLink()) {
      throw storageError(
        "AUTH_CREDENTIAL_PATH_ESCAPE",
        "Credential reset inventory cannot contain symbolic links",
        { target },
      );
    }
    if (entry.isDirectory()) {
      collectResetDirectory(target, policy, files, directories);
      continue;
    }
    if (!entry.isFile()) {
      throw storageError(
        "AUTH_CREDENTIAL_TARGET_NOT_REGULAR_FILE",
        "Credential reset inventory contains a non-regular artifact",
        { target },
      );
    }
    const { contents, stat } = readRegularFileNoFollow(
      target,
      policy,
      "reset-preflight",
    );
    files.push({
      contents,
      file: target,
      mode: stat.mode & 0o777,
      stat: {
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      },
    });
  }
}

function preflightCredentialResetUnlocked(
  policy: AccountStoragePolicy,
): CredentialResetPlan {
  assertStoragePolicy(policy);
  if (!fs.existsSync(policy.authRoot)) {
    return Object.freeze({
      directories: Object.freeze([]),
      files: Object.freeze([]),
    });
  }
  assertRegularDirectory(policy.authRoot, "auth");
  const files: PlannedResetFile[] = [];
  const directories: string[] = [];

  for (const entry of fs.readdirSync(policy.authRoot, {
    withFileTypes: true,
  })) {
    if (
      entry.name === STORAGE_LOCK_DIRECTORY ||
      entry.name === STORAGE_GENERATION_FILE
    ) {
      continue;
    }
    const target = path.join(policy.authRoot, entry.name);
    assertContained(policy.authRoot, target, "reset-root-artifact");
    const credentialDirectory =
      entry.isDirectory() &&
      (entry.name === "_codex-home" ||
        (!entry.name.startsWith(".") && !entry.name.startsWith("_")));
    if (credentialDirectory) {
      collectResetDirectory(target, policy, files, directories);
      continue;
    }
    if (
      entry.name === "_codex-home" ||
      (!entry.name.startsWith(".") &&
        !entry.name.startsWith("_") &&
        entry.isSymbolicLink())
    ) {
      throw storageError(
        "AUTH_CREDENTIAL_PATH_ESCAPE",
        "Credential reset root artifact cannot be a symbolic link",
        { target },
      );
    }
    if (
      entry.name === "_pool-metadata.json" ||
      entry.name.startsWith("_pool-metadata.json.")
    ) {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw storageError(
          "AUTH_CREDENTIAL_TARGET_NOT_REGULAR_FILE",
          "Account-pool metadata reset target must be a regular file",
          { target },
        );
      }
      const { contents, stat } = readRegularFileNoFollow(
        target,
        policy,
        "reset-pool-metadata",
      );
      files.push({
        contents,
        file: target,
        mode: stat.mode & 0o777,
        stat: {
          dev: stat.dev,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        },
      });
    }
  }

  return Object.freeze({
    directories: Object.freeze(directories.sort()),
    files: Object.freeze(files.sort((a, b) => a.file.localeCompare(b.file))),
  });
}

function sameResetInventory(
  left: CredentialResetPlan,
  right: CredentialResetPlan,
): boolean {
  return (
    left.directories.length === right.directories.length &&
    left.directories.every(
      (directory, index) => directory === right.directories[index],
    ) &&
    left.files.length === right.files.length &&
    left.files.every((file, index) => file.file === right.files[index]?.file)
  );
}

function verifyResetPlanUnlocked(
  plan: CredentialResetPlan,
  policy: AccountStoragePolicy,
): void {
  const current = preflightCredentialResetUnlocked(policy);
  if (!sameResetInventory(plan, current)) {
    throw storageError(
      "AUTH_CREDENTIAL_RESET_INVENTORY_CHANGED",
      "Credential artifact inventory changed after reset preflight",
      {
        currentDirectories: current.directories,
        currentFiles: current.files.map((entry) => entry.file),
        plannedDirectories: plan.directories,
        plannedFiles: plan.files.map((entry) => entry.file),
      },
    );
  }
  for (const [index, planned] of plan.files.entries()) {
    const actual = current.files[index];
    if (!actual || !statMatches(actual.stat, planned.stat)) {
      throw storageError(
        "AUTH_CREDENTIAL_RESET_TARGET_CHANGED",
        "Credential artifact changed after reset preflight",
        { file: planned.file },
      );
    }
  }
}

function restoreResetPlanUnlocked(plan: CredentialResetPlan): string[] {
  const failures: string[] = [];
  for (const directory of [...plan.directories].sort(
    (a, b) => a.length - b.length,
  )) {
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (cause) {
      failures.push(`${directory}: ${String(cause)}`);
    }
  }
  for (const artifact of plan.files) {
    try {
      fs.mkdirSync(path.dirname(artifact.file), {
        recursive: true,
        mode: 0o700,
      });
      const descriptor = fs.openSync(
        artifact.file,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        artifact.mode,
      );
      try {
        fs.writeFileSync(descriptor, artifact.contents);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fsyncDirectory(path.dirname(artifact.file));
    } catch (cause) {
      failures.push(`${artifact.file}: ${String(cause)}`);
    }
  }
  return failures;
}

function deleteResetPlanUnlocked(
  plan: CredentialResetPlan,
  policy: AccountStoragePolicy,
): void {
  verifyResetPlanUnlocked(plan, policy);
  const deletedFiles: PlannedResetFile[] = [];
  const removedDirectories: string[] = [];
  try {
    for (const artifact of plan.files) {
      fs.unlinkSync(artifact.file);
      deletedFiles.push(artifact);
    }
    for (const directory of [...plan.directories].sort(
      (a, b) => b.length - a.length,
    )) {
      fs.rmdirSync(directory);
      removedDirectories.push(directory);
    }
    fsyncDirectory(policy.authRoot);
  } catch (cause) {
    const rollbackFailures = restoreResetPlanUnlocked({
      directories: removedDirectories,
      files: deletedFiles,
    });
    throw storageError(
      "AUTH_CREDENTIAL_RESET_DELETE_FAILED",
      "Credential reset deletion failed and was rolled back",
      { rollbackFailures },
      cause,
    );
  }
}

function writeStorageGenerationUnlocked(
  policy: AccountStoragePolicy,
  generation: number,
): void {
  const generationFile = path.join(policy.authRoot, STORAGE_GENERATION_FILE);
  const temporaryFile = `${generationFile}.${process.pid}.${randomUUID()}.tmp`;
  assertContained(policy.authRoot, generationFile, "generation-file");
  assertContained(policy.authRoot, temporaryFile, "temporary-generation-file");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      temporaryFile,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(descriptor, `${generation}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryFile, generationFile);
    fsyncDirectory(policy.authRoot);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryFile)) fs.rmSync(temporaryFile, { force: true });
  }
}

/**
 * Serializes a non-account credential artifact mutation with account writes
 * and reset. The callback must stay inside `policy.authRoot` and must not call
 * another account-storage operation while the lock is held.
 */
export interface AccountStorageMutationScope {
  loadAccount(
    provider: AccountCredentialProvider,
    accountId: string,
  ): AccountCredentialRecord | null;
  saveAccount(record: AccountCredentialRecord): void;
}

export function withAccountStorageMutation<T>(
  policy: AccountStoragePolicy,
  operation: string,
  callback: (scope: AccountStorageMutationScope) => T,
): T {
  return withStorageLock(policy, operation, () =>
    callback({
      loadAccount: (provider, accountId) => {
        assertCanonicalAccountId(accountId);
        return loadAccountUnlocked(provider, accountId, policy);
      },
      saveAccount: (record) => saveAccountUnlocked(record, policy),
    }),
  );
}

/**
 * Deletes every credential-bearing artifact as one fenced transaction, runs
 * the caller's config/environment mutation under the same cross-process lock,
 * and advances the generation before admitting any waiting writer.
 */
export function resetAccountCredentialStorage(
  policy: AccountStoragePolicy,
  mutateResetState: () => void,
): number {
  return withStorageLock(policy, "reset-account-credential-storage", () => {
    const plan = preflightCredentialResetUnlocked(policy);
    deleteResetPlanUnlocked(plan, policy);
    try {
      mutateResetState();
      const currentGeneration =
        policy[ACCOUNT_STORAGE_ROOT_IDENTITY].generation;
      writeStorageGenerationUnlocked(policy, currentGeneration + 1);
    } catch (cause) {
      const rollbackFailures = restoreResetPlanUnlocked(plan);
      throw storageError(
        "AUTH_CREDENTIAL_RESET_TRANSACTION_FAILED",
        "Credential reset failed and credential artifacts were rolled back",
        { rollbackFailures },
        cause,
      );
    }
    return plan.files.length;
  });
}

function saveAccountUnlocked(
  record: AccountCredentialRecord,
  policy: AccountStoragePolicy,
): void {
  assertStoragePolicy(policy);
  assertCanonicalAccountId(record.id);
  const persistedRecord: unknown = record;
  if (!isAccountCredentialRecord(persistedRecord)) {
    throw storageError(
      "AUTH_CREDENTIAL_RECORD_INVALID",
      "Credential mutation requires a complete persisted record",
      { accountId: record.id, provider: record.providerId },
    );
  }
  ensureProviderDir(record.providerId, policy);
  const next: AccountCredentialRecord = {
    ...record,
    updatedAt: Date.now(),
  };
  writeAccountFile(record.providerId, record.id, policy, next);
  logger.info(
    `[auth] Saved ${record.providerId} account "${record.id}" (label="${record.label}")`,
  );
}

export function saveAccount(
  record: AccountCredentialRecord,
  policy: AccountStoragePolicy,
): void {
  assertCanonicalAccountId(record.id);
  withStorageLock(policy, "save-account", () =>
    saveAccountUnlocked(record, policy),
  );
}

export function deleteAccount(
  provider: AccountCredentialProvider,
  accountId: string,
  policy: AccountStoragePolicy,
): void {
  assertCanonicalAccountId(accountId);
  withStorageLock(policy, "delete-account", () => {
    const plan = preflightAccountDeletionsUnlocked(
      [{ provider, accountId }],
      policy,
    );
    if (commitAccountDeletionsUnlocked(plan) > 0) {
      logger.info(`[auth] Deleted ${provider} account "${accountId}"`);
    }
  });
}

export function touchAccount(
  provider: AccountCredentialProvider,
  accountId: string,
  policy: AccountStoragePolicy,
): void {
  assertCanonicalAccountId(accountId);
  withStorageLock(policy, "touch-account", () => {
    const existing = loadAccountUnlocked(provider, accountId, policy);
    if (!existing) return;
    const next: AccountCredentialRecord = {
      ...existing,
      lastUsedAt: Date.now(),
    };
    writeAccountFile(provider, accountId, policy, next);
  });
}
