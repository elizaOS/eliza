/**
 * Per-account credential storage.
 *
 * Layout: `<stateDir>/auth/{providerId}/{accountId}.json` (mode 0600,
 * atomic writes). Multiple accounts per provider are supported. Every mutator
 * requires a branded root/owner policy; isolated policies are physically
 * confined to the OS temporary directory and no operation may cross its
 * canonical provider directory.
 *
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError, logger, resolveStateDir } from "@elizaos/core";
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

export interface AccountStoragePolicy {
  readonly stateRoot: string;
  readonly authRoot: string;
  readonly owner: AccountStorageOwner;
  readonly [ACCOUNT_STORAGE_POLICY]: true;
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
  readonly [ACCOUNT_DELETION_PLAN]: true;
}

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
  return Object.freeze({
    stateRoot: canonicalStateRoot,
    authRoot,
    owner,
    [ACCOUNT_STORAGE_POLICY]: true as const,
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
      "Credential mutation requires a policy created by account-storage",
      {},
    );
  }
  const physicalStateRoot = resolvePhysicalPath(policy.stateRoot);
  if (physicalStateRoot !== policy.stateRoot) {
    throw storageError(
      "AUTH_CREDENTIAL_STORAGE_ROOT_CHANGED",
      "Account storage root changed after policy creation",
      { stateRoot: policy.stateRoot, physicalStateRoot },
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
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertStoragePolicy(policy);
    assertContained(dir, temporaryFile, "temporary-account-file");
    assertContained(dir, file, "account-file");
    fs.renameSync(temporaryFile, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporaryFile)) {
      const stat = fs.lstatSync(temporaryFile);
      if (!stat.isSymbolicLink()) fs.rmSync(temporaryFile, { force: true });
    }
  }
}

function statMatches(
  actual: fs.Stats,
  expected: NonNullable<PlannedAccountDeletion["stat"]>,
): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeMs === expected.mtimeMs
  );
}

export function preflightAccountDeletions(
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

export function preflightProviderAccountDeletions(
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
  return preflightAccountDeletions(accounts, policy);
}

export function commitAccountDeletions(plan: AccountDeletionPlan): number {
  if (plan?.[ACCOUNT_DELETION_PLAN] !== true) {
    throw storageError(
      "AUTH_CREDENTIAL_DELETE_PLAN_INVALID",
      "Credential deletion requires a preflighted plan",
      {},
    );
  }
  assertStoragePolicy(plan.policy);

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
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const target of deleted.reverse()) {
      try {
        fs.writeFileSync(target.file, target.contents, {
          flag: "wx",
          mode: target.mode,
        });
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

function isAccountCredentialRecord(
  value: unknown,
): value is AccountCredentialRecord {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.providerId === "string" &&
    (ACCOUNT_CREDENTIAL_PROVIDER_IDS as readonly string[]).includes(
      v.providerId,
    ) &&
    typeof v.label === "string" &&
    (v.source === "oauth" || v.source === "api-key") &&
    typeof v.credentials === "object" &&
    v.credentials !== null &&
    typeof (v.credentials as Record<string, unknown>).access === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.updatedAt === "number"
  );
}

export function listAccounts(
  provider: AccountCredentialProvider,
  policy: AccountStoragePolicy = defaultReadPolicy(),
): AccountCredentialRecord[] {
  const dir = providerDir(provider, policy);
  if (!fs.existsSync(dir)) return [];
  assertContained(policy.authRoot, dir, "list-provider-directory");

  const entries = fs.readdirSync(dir);
  const records: AccountCredentialRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (entry.endsWith(".tmp.json") || entry.endsWith(".json.tmp")) continue;
    const filePath = path.join(dir, entry);
    assertContained(dir, filePath, "list-account-file");
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      logger.warn(`[auth] Skipping symlinked credential file ${filePath}`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      logger.warn(
        `[auth] Skipping malformed credential file ${filePath}: ${String(err)}`,
      );
      continue;
    }
    if (!isAccountCredentialRecord(parsed)) {
      logger.warn(`[auth] Skipping credential file ${filePath} — wrong shape`);
      continue;
    }
    if (parsed.providerId !== provider) {
      logger.warn(
        `[auth] Credential file ${filePath} declares providerId="${parsed.providerId}", expected "${provider}" — skipping`,
      );
      continue;
    }
    try {
      assertCanonicalAccountId(parsed.id);
    } catch (error) {
      logger.warn(
        `[auth] Skipping credential file ${filePath} with invalid account id: ${String(error)}`,
      );
      continue;
    }
    if (`${parsed.id}.json` !== entry) {
      logger.warn(
        `[auth] Credential file ${filePath} does not match account id "${parsed.id}" — skipping`,
      );
      continue;
    }
    records.push(parsed);
  }

  records.sort((a, b) => a.createdAt - b.createdAt);
  return records;
}

export function loadAccount(
  provider: AccountCredentialProvider,
  accountId: string,
  policy: AccountStoragePolicy = defaultReadPolicy(),
): AccountCredentialRecord | null {
  const file = accountFile(provider, accountId, policy);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `[auth] Credential file ${file} is malformed JSON: ${String(err)}`,
    );
    return null;
  }
  if (!isAccountCredentialRecord(parsed)) {
    logger.warn(`[auth] Credential file ${file} has wrong shape`);
    return null;
  }
  if (parsed.providerId !== provider || parsed.id !== accountId) {
    logger.warn(
      `[auth] Credential file ${file} provider/id mismatch (got ${parsed.providerId}/${parsed.id})`,
    );
    return null;
  }
  return parsed;
}

export function saveAccount(
  record: AccountCredentialRecord,
  policy: AccountStoragePolicy,
): void {
  assertStoragePolicy(policy);
  assertCanonicalAccountId(record.id);
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

export function deleteAccount(
  provider: AccountCredentialProvider,
  accountId: string,
  policy: AccountStoragePolicy,
): void {
  const plan = preflightAccountDeletions([{ provider, accountId }], policy);
  if (commitAccountDeletions(plan) > 0) {
    logger.info(`[auth] Deleted ${provider} account "${accountId}"`);
  }
}

export function touchAccount(
  provider: AccountCredentialProvider,
  accountId: string,
  policy: AccountStoragePolicy,
): void {
  assertStoragePolicy(policy);
  const existing = loadAccount(provider, accountId, policy);
  if (!existing) return;
  const next: AccountCredentialRecord = {
    ...existing,
    lastUsedAt: Date.now(),
  };
  writeAccountFile(provider, accountId, policy, next);
}
