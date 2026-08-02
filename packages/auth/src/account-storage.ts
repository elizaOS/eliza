/**
 * Per-account credential storage.
 *
 * Layout: `<stateDir>/auth/{providerId}/{accountId}.json` (mode 0600,
 * atomic writes). Multiple accounts per provider are supported. Test-process
 * deletion is confined to physically resolved OS temporary paths so inherited
 * developer state and symlink targets cannot be removed.
 *
 */

import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError, logger, resolveStateDir } from "@elizaos/core";
import { writeJsonAtomicSync } from "./atomic-json.ts";
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

function authRoot(): string {
  return path.join(process.env.ELIZA_HOME || resolveStateDir(), "auth");
}

function providerDir(provider: AccountCredentialProvider): string {
  return path.join(authRoot(), provider);
}

function accountFile(
  provider: AccountCredentialProvider,
  accountId: string,
): string {
  return path.join(providerDir(provider), `${accountId}.json`);
}

function ensureProviderDir(provider: AccountCredentialProvider): void {
  const dir = providerDir(provider);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

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

function isPathWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolvePhysicalPath(target: string): string {
  let existingAncestor = path.resolve(target);
  const missingSegments: string[] = [];

  // Missing account files still need their nearest existing ancestor resolved;
  // otherwise an `auth` or provider symlink could make a lexical temp path unsafe.
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

function isUnderOsTempDir(target: string): boolean {
  const resolvedTarget = path.resolve(target);
  const resolvedTemp = path.resolve(tmpdir());
  if (!isPathWithin(resolvedTemp, resolvedTarget)) {
    return false;
  }

  return isPathWithin(
    fs.realpathSync.native(resolvedTemp),
    resolvePhysicalPath(resolvedTarget),
  );
}

function assertDestructiveStorageAllowed(file: string): void {
  if (!isTestProcess() || process.env.ELIZA_ALLOW_REAL_STATE_IN_TESTS === "1") {
    return;
  }

  if (isUnderOsTempDir(file)) {
    return;
  }

  throw new ElizaError(
    "Refusing to delete credentials from a non-temporary Eliza state directory during tests. " +
      "Set ELIZA_HOME or ELIZA_STATE_DIR to a mkdtemp directory under the OS temporary directory, " +
      "or set ELIZA_ALLOW_REAL_STATE_IN_TESTS=1 to override.",
    {
      code: "AUTH_CREDENTIAL_DELETE_OUTSIDE_TEST_STATE",
      context: { file },
      severity: "fatal",
    },
  );
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
): AccountCredentialRecord[] {
  const dir = providerDir(provider);
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir);
  const records: AccountCredentialRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (entry.endsWith(".tmp.json") || entry.endsWith(".json.tmp")) continue;
    const filePath = path.join(dir, entry);
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
    records.push(parsed);
  }

  records.sort((a, b) => a.createdAt - b.createdAt);
  return records;
}

export function loadAccount(
  provider: AccountCredentialProvider,
  accountId: string,
): AccountCredentialRecord | null {
  const file = accountFile(provider, accountId);
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

export function saveAccount(record: AccountCredentialRecord): void {
  ensureProviderDir(record.providerId);
  const next: AccountCredentialRecord = {
    ...record,
    updatedAt: Date.now(),
  };
  writeJsonAtomicSync(accountFile(record.providerId, record.id), next);
  logger.info(
    `[auth] Saved ${record.providerId} account "${record.id}" (label="${record.label}")`,
  );
}

export function deleteAccount(
  provider: AccountCredentialProvider,
  accountId: string,
): void {
  const file = accountFile(provider, accountId);
  assertDestructiveStorageAllowed(file);
  try {
    fs.unlinkSync(file);
    logger.info(`[auth] Deleted ${provider} account "${accountId}"`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

export function touchAccount(
  provider: AccountCredentialProvider,
  accountId: string,
): void {
  const existing = loadAccount(provider, accountId);
  if (!existing) return;
  const next: AccountCredentialRecord = {
    ...existing,
    lastUsedAt: Date.now(),
  };
  writeJsonAtomicSync(accountFile(provider, accountId), next);
}
