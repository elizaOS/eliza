/**
 * Per-account credential storage.
 *
 * Layout: `~/.eliza/auth/{providerId}/{accountId}.json` (mode 0600,
 * atomic writes). Multiple accounts per provider are supported.
 *
 * Migration: on first read of a provider, if the legacy single-file
 * `~/.eliza/auth/{providerId}.json` exists and the per-account
 * directory does not, the legacy file is moved to
 * `<dir>/default.json` and the legacy file is removed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { writeJsonAtomicSync } from "../utils/atomic-json.ts";
import {
  ACCOUNT_CREDENTIAL_PROVIDER_IDS,
  type AccountCredentialProvider,
  isSubscriptionProvider,
  type OAuthCredentials,
  type SubscriptionProvider,
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
   * a far-future sentinel by convention of the caller).
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
  return path.join(
    process.env.ELIZA_HOME || path.join(os.homedir(), ".eliza"),
    "auth",
  );
}

function providerDir(provider: AccountCredentialProvider): string {
  return path.join(authRoot(), provider);
}

function legacyProviderFile(provider: SubscriptionProvider): string {
  return path.join(authRoot(), `${provider}.json`);
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

interface LegacyStoredCredentials {
  provider: SubscriptionProvider;
  credentials: OAuthCredentials;
  createdAt: number;
  updatedAt: number;
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

const migratedProviders = new Set<SubscriptionProvider>();
let migrationRunAtLeastOnce = false;

function migrateProvider(provider: SubscriptionProvider): boolean {
  if (migratedProviders.has(provider)) return false;
  migratedProviders.add(provider);

  const dir = providerDir(provider);
  const legacy = legacyProviderFile(provider);

  if (!fs.existsSync(legacy)) return false;
  if (fs.existsSync(dir)) {
    // Per-account directory already exists — leave the legacy file
    // alone (operator may be mid-migration). Don't auto-delete.
    return false;
  }

  let parsed: LegacyStoredCredentials | null = null;
  try {
    const raw = fs.readFileSync(legacy, "utf-8");
    parsed = JSON.parse(raw) as LegacyStoredCredentials;
  } catch (err) {
    logger.warn(
      `[auth] Failed to read legacy credential file for migration ${legacy}: ${String(err)}`,
    );
    return false;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.credentials ||
    typeof parsed.credentials.access !== "string"
  ) {
    logger.warn(
      `[auth] Legacy credential file ${legacy} is malformed — skipping migration`,
    );
    return false;
  }

  const now = Date.now();
  const record: AccountCredentialRecord = {
    id: "default",
    providerId: provider,
    label: "Default",
    source: "oauth",
    credentials: parsed.credentials,
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : now,
    updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : now,
  };

  ensureProviderDir(provider);
  writeJsonAtomicSync(accountFile(provider, "default"), record);

  // Atomic-ish delete: rename to a side path first so a concurrent
  // reader sees either the legacy file or nothing — then unlink.
  const removed = `${legacy}.migrated-${now}`;
  try {
    fs.renameSync(legacy, removed);
    fs.unlinkSync(removed);
  } catch (err) {
    logger.warn(
      `[auth] Failed to remove legacy credential file ${legacy} after migration: ${String(err)}`,
    );
  }

  logger.info(
    `[auth] Migrated legacy ${provider} credentials to per-account store as "default"`,
  );
  return true;
}

/**
 * Run the legacy → per-account migration for both known subscription
 * providers. Idempotent: each provider migrates at most once per
 * process. Returns the providers that were actually migrated this
 * call.
 */
export function migrateLegacySingleAccount(): {
  migrated: SubscriptionProvider[];
} {
  migrationRunAtLeastOnce = true;
  const providers: SubscriptionProvider[] = [
    "anthropic-subscription",
    "openai-codex",
  ];
  const migrated: SubscriptionProvider[] = [];
  for (const p of providers) {
    if (migrateProvider(p)) migrated.push(p);
  }
  return { migrated };
}

function ensureMigrationOnce(): void {
  if (!migrationRunAtLeastOnce) {
    migrateLegacySingleAccount();
  }
}

export function listAccounts(
  provider: AccountCredentialProvider,
): AccountCredentialRecord[] {
  ensureMigrationOnce();
  // Run provider-specific migration too in case a new provider was
  // added after the first global pass.
  if (isSubscriptionProvider(provider)) {
    migrateProvider(provider);
  }

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
  ensureMigrationOnce();
  if (isSubscriptionProvider(provider)) {
    migrateProvider(provider);
  }

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
