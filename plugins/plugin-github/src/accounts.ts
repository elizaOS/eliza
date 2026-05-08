import type { IAgentRuntime } from "@elizaos/core";
import {
  listConnectorAccounts,
  loadConnectorOAuthAccessToken,
} from "./connector-credential-refs.js";
import { GITHUB_SERVICE_TYPE, type GitHubIdentity } from "./types.js";

export const DEFAULT_GITHUB_USER_ACCOUNT_ID = "user";
export const DEFAULT_GITHUB_AGENT_ACCOUNT_ID = "agent";

export interface GitHubAccountConfig {
  accountId: string;
  role: GitHubIdentity;
  token: string;
  label?: string;
}

export interface GitHubAccountSelection {
  accountId?: string;
  role: GitHubIdentity;
}

type RawAccountRecord = Record<string, unknown>;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readSetting(runtime: IAgentRuntime, key: string): string | undefined {
  return nonEmptyString(runtime.getSetting(key));
}

function normalizeRole(value: unknown): GitHubIdentity | undefined {
  return value === "user" || value === "agent" ? value : undefined;
}

export function defaultGitHubAccountIdForRole(role: GitHubIdentity): string {
  return role === "user"
    ? DEFAULT_GITHUB_USER_ACCOUNT_ID
    : DEFAULT_GITHUB_AGENT_ACCOUNT_ID;
}

export function normalizeGitHubAccountId(value: unknown): string | undefined {
  return nonEmptyString(value);
}

export function resolveGitHubAccountSelection(
  options: Record<string, unknown> | undefined,
  defaultRole: GitHubIdentity,
): GitHubAccountSelection {
  const requestedAccountId = normalizeGitHubAccountId(options?.accountId);
  const requestedRole = normalizeRole(options?.as);
  return {
    accountId: requestedAccountId,
    role:
      requestedRole ??
      normalizeRole(requestedAccountId) ??
      defaultRole,
  };
}

function parseAccountsJson(raw: string | undefined): RawAccountRecord[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is RawAccountRecord =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      );
    }
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => value && typeof value === "object")
        .map(([id, value]) => ({
          ...(value as RawAccountRecord),
          accountId: (value as RawAccountRecord).accountId ?? id,
        }));
    }
  } catch {
    return [];
  }
  return [];
}

function readRawField(
  record: RawAccountRecord,
  keys: readonly string[],
): string | undefined {
  const credentials =
    record.credentials && typeof record.credentials === "object"
      ? (record.credentials as RawAccountRecord)
      : {};
  const settings =
    record.settings && typeof record.settings === "object"
      ? (record.settings as RawAccountRecord)
      : {};

  for (const source of [record, credentials, settings]) {
    for (const key of keys) {
      const value = nonEmptyString(source[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function accountFromRecord(record: RawAccountRecord): GitHubAccountConfig | null {
  const accountId = normalizeGitHubAccountId(
    record.accountId ?? record.id ?? record.name,
  );
  const role =
    normalizeRole(record.role) ??
    normalizeRole(record.as) ??
    normalizeRole(accountId);
  const token = readRawField(record, [
    "GITHUB_PAT",
    "GITHUB_TOKEN",
    "GITHUB_ACCESS_TOKEN",
    "token",
    "pat",
    "accessToken",
    "access",
  ]);
  if (!accountId || !role || !token) {
    return null;
  }
  return {
    accountId,
    role,
    token,
    label: nonEmptyString(record.label ?? record.displayName),
  };
}

function addAccount(
  accounts: Map<string, GitHubAccountConfig>,
  account: GitHubAccountConfig | null,
): void {
  if (account) {
    accounts.set(account.accountId, account);
  }
}

export function readGitHubAccounts(runtime: IAgentRuntime): GitHubAccountConfig[] {
  const accounts = new Map<string, GitHubAccountConfig>();
  const characterConfig = runtime.character?.settings?.github as
    | { accounts?: unknown }
    | undefined;
  const characterAccounts = characterConfig?.accounts;

  if (Array.isArray(characterAccounts)) {
    for (const item of characterAccounts) {
      if (item && typeof item === "object") {
        addAccount(accounts, accountFromRecord(item as RawAccountRecord));
      }
    }
  } else if (characterAccounts && typeof characterAccounts === "object") {
    for (const [id, value] of Object.entries(
      characterAccounts as Record<string, unknown>,
    )) {
      if (value && typeof value === "object") {
        addAccount(
          accounts,
          accountFromRecord({
            ...(value as RawAccountRecord),
            accountId: (value as RawAccountRecord).accountId ?? id,
          }),
        );
      }
    }
  }

  for (const record of parseAccountsJson(
    readSetting(runtime, "GITHUB_ACCOUNTS"),
  )) {
    addAccount(accounts, accountFromRecord(record));
  }

  addAccount(
    accounts,
    legacyAccount(
      runtime,
      "user",
      readSetting(runtime, "GITHUB_USER_ACCOUNT_ID") ??
        DEFAULT_GITHUB_USER_ACCOUNT_ID,
      "GITHUB_USER_PAT",
      "ELIZA_E2E_GITHUB_USER_PAT",
    ),
  );
  addAccount(
    accounts,
    legacyAccount(
      runtime,
      "agent",
      readSetting(runtime, "GITHUB_AGENT_ACCOUNT_ID") ??
        DEFAULT_GITHUB_AGENT_ACCOUNT_ID,
      "GITHUB_AGENT_PAT",
      "ELIZA_E2E_GITHUB_AGENT_PAT",
    ),
  );

  return Array.from(accounts.values());
}

export async function readGitHubAccountsWithConnectorCredentials(
  runtime: IAgentRuntime,
): Promise<GitHubAccountConfig[]> {
  const accounts = new Map<string, GitHubAccountConfig>();
  for (const account of readGitHubAccounts(runtime)) {
    accounts.set(account.accountId, account);
  }

  const connectorAccounts = await listConnectorAccounts(runtime, GITHUB_SERVICE_TYPE);
  for (const account of connectorAccounts) {
    if (account.status !== "connected") continue;
    const token = await loadConnectorOAuthAccessToken({
      runtime,
      provider: GITHUB_SERVICE_TYPE,
      accountId: account.id,
      caller: "plugin-github",
    });
    if (!token) continue;
    accounts.set(account.id, {
      accountId: account.id,
      role: connectorRoleToIdentity(account.role),
      token,
      label: account.label ?? account.displayHandle,
    });
  }

  return Array.from(accounts.values());
}

function legacyAccount(
  runtime: IAgentRuntime,
  role: GitHubIdentity,
  accountId: string,
  primaryKey: string,
  fallbackKey: string,
): GitHubAccountConfig | null {
  const token = readSetting(runtime, primaryKey) ?? readSetting(runtime, fallbackKey);
  if (!token) return null;
  return { accountId, role, token };
}

function connectorRoleToIdentity(role: unknown): GitHubIdentity {
  return typeof role === "string" && role.toUpperCase() === "AGENT" ? "agent" : "user";
}

export function resolveGitHubAccount(
  accounts: readonly GitHubAccountConfig[],
  selection: GitHubAccountSelection,
): GitHubAccountConfig | null {
  if (selection.accountId) {
    const exact = accounts.find(
      (account) => account.accountId === selection.accountId,
    );
    if (exact) return exact;
  }

  const legacyId = defaultGitHubAccountIdForRole(selection.role);
  return (
    accounts.find((account) => account.accountId === legacyId) ??
    accounts.find((account) => account.role === selection.role) ??
    null
  );
}
