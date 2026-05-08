import type { IAgentRuntime } from "@elizaos/core";

export const DEFAULT_LINEAR_ACCOUNT_ID = "default";

export interface LinearAccountConfig {
  accountId: string;
  apiKey: string;
  workspaceId?: string;
  defaultTeamKey?: string;
  label?: string;
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

export function normalizeLinearAccountId(value: unknown): string {
  return nonEmptyString(value) ?? DEFAULT_LINEAR_ACCOUNT_ID;
}

export function resolveLinearAccountId(
  runtime: IAgentRuntime,
  options?: Record<string, unknown>,
): string {
  return normalizeLinearAccountId(
    options?.accountId ??
      options?.linearAccountId ??
      readSetting(runtime, "LINEAR_DEFAULT_ACCOUNT_ID") ??
      readSetting(runtime, "LINEAR_ACCOUNT_ID"),
  );
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
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as RawAccountRecord)
      : {};
  const settings =
    record.settings && typeof record.settings === "object"
      ? (record.settings as RawAccountRecord)
      : {};

  for (const source of [record, credentials, metadata, settings]) {
    for (const key of keys) {
      const value = nonEmptyString(source[key]);
      if (value) return value;
    }
  }
  return undefined;
}

function accountFromRecord(record: RawAccountRecord): LinearAccountConfig | null {
  const accountId = normalizeLinearAccountId(
    record.accountId ?? record.id ?? record.name,
  );
  const apiKey = readRawField(record, [
    "LINEAR_API_KEY",
    "apiKey",
    "token",
    "accessToken",
    "access",
  ]);
  if (!apiKey) return null;
  return {
    accountId,
    apiKey,
    workspaceId: readRawField(record, [
      "LINEAR_WORKSPACE_ID",
      "workspaceId",
    ]),
    defaultTeamKey: readRawField(record, [
      "LINEAR_DEFAULT_TEAM_KEY",
      "defaultTeamKey",
    ]),
    label: nonEmptyString(record.label ?? record.displayName),
  };
}

function addAccount(
  accounts: Map<string, LinearAccountConfig>,
  account: LinearAccountConfig | null,
): void {
  if (account) {
    accounts.set(account.accountId, account);
  }
}

export function readLinearAccounts(runtime: IAgentRuntime): LinearAccountConfig[] {
  const accounts = new Map<string, LinearAccountConfig>();
  const characterConfig = runtime.character?.settings?.linear as
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
    readSetting(runtime, "LINEAR_ACCOUNTS"),
  )) {
    addAccount(accounts, accountFromRecord(record));
  }

  const apiKey = readSetting(runtime, "LINEAR_API_KEY");
  if (apiKey) {
    addAccount(accounts, {
      accountId: normalizeLinearAccountId(
        readSetting(runtime, "LINEAR_ACCOUNT_ID") ??
          readSetting(runtime, "LINEAR_DEFAULT_ACCOUNT_ID"),
      ),
      apiKey,
      workspaceId: readSetting(runtime, "LINEAR_WORKSPACE_ID"),
      defaultTeamKey: readSetting(runtime, "LINEAR_DEFAULT_TEAM_KEY"),
    });
  }

  return Array.from(accounts.values());
}

export function resolveLinearAccount(
  accounts: readonly LinearAccountConfig[],
  accountId: string,
): LinearAccountConfig | null {
  return (
    accounts.find((account) => account.accountId === accountId) ??
    accounts.find((account) => account.accountId === DEFAULT_LINEAR_ACCOUNT_ID) ??
    accounts[0] ??
    null
  );
}

export function hasLinearAccountConfig(
  runtime: IAgentRuntime,
  options?: Record<string, unknown>,
): boolean {
  const accountId = resolveLinearAccountId(runtime, options);
  return Boolean(resolveLinearAccount(readLinearAccounts(runtime), accountId));
}
