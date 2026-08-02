/**
 * Encrypted per-account credential persistence using the vault master key.
 * Legacy plaintext records are validated and replaced atomically with a
 * versioned AES-GCM envelope before they are returned to callers.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ElizaError,
  logger,
  resolveStateDir,
} from "@elizaos/core";
import { writeJsonAtomicSync } from "@elizaos/core/atomic-json";
import {
  decrypt,
  encrypt,
  loadDefaultMasterKeySync,
} from "@elizaos/vault";
import {
  ACCOUNT_CREDENTIAL_PROVIDER_IDS,
  type AccountCredentialProvider,
  type OAuthCredentials,
} from "./types.ts";

export interface AccountCredentialRecord {
  id: string;
  providerId: AccountCredentialProvider;
  label: string;
  source: "oauth" | "api-key";
  credentials: OAuthCredentials;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  organizationId?: string;
  userId?: string;
  email?: string;
}

interface EncryptedAccountEnvelope {
  schemaVersion: 2;
  ciphertext: string;
}

const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const testKeys = new Map<string, Buffer>();

function authRoot(): string {
  return path.join(process.env.ELIZA_HOME || resolveStateDir(), "auth");
}

function providerDir(provider: AccountCredentialProvider): string {
  return path.join(authRoot(), provider);
}

function assertAccountId(accountId: string): void {
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new ElizaError("Invalid account credential id", {
      code: "AUTH_ACCOUNT_ID_INVALID",
      context: { accountId },
      severity: "fatal",
    });
  }
}

function accountFile(
  provider: AccountCredentialProvider,
  accountId: string,
): string {
  assertAccountId(accountId);
  return path.join(providerDir(provider), `${accountId}.json`);
}

function accountAad(provider: AccountCredentialProvider, accountId: string) {
  return `@elizaos/auth/account/${provider}/${accountId}`;
}

function ensureProviderDir(provider: AccountCredentialProvider): void {
  fs.mkdirSync(providerDir(provider), { recursive: true, mode: 0o700 });
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

function masterKey(): Buffer {
  if (!isTestProcess()) return loadDefaultMasterKeySync();
  const root = path.resolve(authRoot());
  const existing = testKeys.get(root);
  if (existing) return existing;
  const created = randomBytes(32);
  testKeys.set(root, created);
  return created;
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
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return path.resolve(target);
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
  return (
    isPathWithin(resolvedTemp, resolvedTarget) &&
    isPathWithin(
      fs.realpathSync.native(resolvedTemp),
      resolvePhysicalPath(resolvedTarget),
    )
  );
}

function assertDestructiveStorageAllowed(file: string): void {
  if (!isTestProcess() || process.env.ELIZA_ALLOW_REAL_STATE_IN_TESTS === "1") {
    return;
  }
  if (isUnderOsTempDir(file)) return;
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

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function parseRecord(value: unknown, source: string): AccountCredentialRecord {
  const record = value as Record<string, unknown> | null;
  const credentials = record?.credentials as Record<string, unknown> | null;
  const valid =
    record !== null &&
    typeof record === "object" &&
    typeof record.id === "string" &&
    ACCOUNT_ID_PATTERN.test(record.id) &&
    typeof record.providerId === "string" &&
    (ACCOUNT_CREDENTIAL_PROVIDER_IDS as readonly string[]).includes(
      record.providerId,
    ) &&
    typeof record.label === "string" &&
    (record.source === "oauth" || record.source === "api-key") &&
    credentials !== null &&
    typeof credentials === "object" &&
    typeof credentials.access === "string" &&
    typeof credentials.refresh === "string" &&
    typeof credentials.expires === "number" &&
    Number.isFinite(credentials.expires) &&
    optionalString(credentials.idToken) &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.updatedAt === "number" &&
    Number.isFinite(record.updatedAt) &&
    (record.lastUsedAt === undefined ||
      (typeof record.lastUsedAt === "number" &&
        Number.isFinite(record.lastUsedAt))) &&
    optionalString(record.organizationId) &&
    optionalString(record.userId) &&
    optionalString(record.email);
  if (!valid) {
    throw new ElizaError("Credential record is malformed", {
      code: "AUTH_CREDENTIAL_RECORD_INVALID",
      context: { source },
      severity: "fatal",
    });
  }
  return value as AccountCredentialRecord;
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

function writeEncrypted(record: AccountCredentialRecord): void {
  ensureProviderDir(record.providerId);
  const envelope: EncryptedAccountEnvelope = {
    schemaVersion: 2,
    ciphertext: encrypt(
      masterKey(),
      JSON.stringify(record),
      accountAad(record.providerId, record.id),
    ),
  };
  writeJsonAtomicSync(accountFile(record.providerId, record.id), envelope);
}

function readRecord(
  provider: AccountCredentialProvider,
  file: string,
): AccountCredentialRecord {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const value = isEnvelope(parsed)
    ? (JSON.parse(
        decrypt(
          masterKey(),
          parsed.ciphertext,
          accountAad(provider, path.basename(file, ".json")),
        ),
      ) as unknown)
    : parsed;
  const record = parseRecord(value, file);
  if (
    record.providerId !== provider ||
    accountFile(provider, record.id) !== file
  ) {
    throw new ElizaError("Credential identity does not match its path", {
      code: "AUTH_CREDENTIAL_IDENTITY_MISMATCH",
      context: { file, provider, recordId: record.id },
      severity: "fatal",
    });
  }
  if (!isEnvelope(parsed)) {
    writeEncrypted(record);
    logger.info(`[auth] Migrated ${provider} account "${record.id}" to encrypted storage`);
  }
  return record;
}

export function listAccounts(
  provider: AccountCredentialProvider,
): AccountCredentialRecord[] {
  const dir = providerDir(provider);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = entries
    .filter((entry) => entry.endsWith(".json") && !entry.includes(".tmp"))
    .map((entry) => readRecord(provider, path.join(dir, entry)));
  records.sort((a, b) => a.createdAt - b.createdAt);
  return records;
}

export function loadAccount(
  provider: AccountCredentialProvider,
  accountId: string,
): AccountCredentialRecord | null {
  const file = accountFile(provider, accountId);
  try {
    return readRecord(provider, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function saveAccount(record: AccountCredentialRecord): void {
  const next = parseRecord(
    { ...record, updatedAt: Date.now() },
    "saveAccount input",
  );
  writeEncrypted(next);
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
  } catch (error) {
    // error-policy:J1 boundary translation — deleting an already-absent
    // credential is the idempotent success case; every other filesystem
    // failure remains observable.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  logger.info(`[auth] Deleted ${provider} account "${accountId}"`);
}

export function touchAccount(
  provider: AccountCredentialProvider,
  accountId: string,
): void {
  const existing = loadAccount(provider, accountId);
  if (!existing) return;
  saveAccount({ ...existing, lastUsedAt: Date.now() });
}
