import type { IAgentRuntime } from "@elizaos/core";

export const DEFAULT_TAILSCALE_ACCOUNT_ID = "default";

export interface TailscaleAccountConfig {
  accountId: string;
  authKey?: string;
  tags?: string | string[];
  funnel?: string | boolean;
  defaultPort?: string | number;
  backend?: "local" | "cloud" | "auto";
  authKeyExpirySeconds?: string | number;
  cloudApiKey?: string;
  cloudBaseUrl?: string;
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

export function normalizeTailscaleAccountId(value: unknown): string {
  return nonEmptyString(value) ?? DEFAULT_TAILSCALE_ACCOUNT_ID;
}

export function resolveTailscaleAccountId(
  runtime: IAgentRuntime,
  options?: Record<string, unknown>,
): string {
  return normalizeTailscaleAccountId(
    options?.accountId ??
      options?.tailscaleAccountId ??
      readSetting(runtime, "TAILSCALE_DEFAULT_ACCOUNT_ID") ??
      readSetting(runtime, "TAILSCALE_ACCOUNT_ID"),
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
): unknown {
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
      const value = source[key];
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  return undefined;
}

function normalizeBackend(
  value: unknown,
): "local" | "cloud" | "auto" | undefined {
  return value === "local" || value === "cloud" || value === "auto"
    ? value
    : undefined;
}

function accountFromRecord(
  record: RawAccountRecord,
): TailscaleAccountConfig | null {
  const accountId = normalizeTailscaleAccountId(
    record.accountId ?? record.id ?? record.name,
  );
  const account: TailscaleAccountConfig = {
    accountId,
    authKey: nonEmptyString(
      readRawField(record, [
        "TAILSCALE_AUTH_KEY",
        "authKey",
        "accessToken",
        "access",
      ]),
    ),
    tags: readRawField(record, ["TAILSCALE_TAGS", "tags"]) as
      | string
      | string[]
      | undefined,
    funnel: readRawField(record, ["TAILSCALE_FUNNEL", "funnel"]) as
      | string
      | boolean
      | undefined,
    defaultPort: readRawField(record, [
      "TAILSCALE_DEFAULT_PORT",
      "defaultPort",
    ]) as string | number | undefined,
    backend: normalizeBackend(
      readRawField(record, ["TAILSCALE_BACKEND", "backend"]),
    ),
    authKeyExpirySeconds: readRawField(record, [
      "TAILSCALE_AUTH_KEY_EXPIRY_SECONDS",
      "authKeyExpirySeconds",
    ]) as string | number | undefined,
    cloudApiKey: nonEmptyString(
      readRawField(record, ["ELIZAOS_CLOUD_API_KEY", "cloudApiKey"]),
    ),
    cloudBaseUrl: nonEmptyString(
      readRawField(record, ["ELIZAOS_CLOUD_BASE_URL", "cloudBaseUrl"]),
    ),
    label: nonEmptyString(record.label ?? record.displayName),
  };
  return account;
}

function addAccount(
  accounts: Map<string, TailscaleAccountConfig>,
  account: TailscaleAccountConfig | null,
): void {
  if (account) {
    accounts.set(account.accountId, account);
  }
}

export function readTailscaleAccounts(
  runtime: IAgentRuntime,
): TailscaleAccountConfig[] {
  const accounts = new Map<string, TailscaleAccountConfig>();
  const characterConfig = runtime.character?.settings?.tailscale as
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
    readSetting(runtime, "TAILSCALE_ACCOUNTS"),
  )) {
    addAccount(accounts, accountFromRecord(record));
  }

  addAccount(accounts, {
    accountId: normalizeTailscaleAccountId(
      readSetting(runtime, "TAILSCALE_ACCOUNT_ID") ??
        readSetting(runtime, "TAILSCALE_DEFAULT_ACCOUNT_ID"),
    ),
    authKey: readSetting(runtime, "TAILSCALE_AUTH_KEY"),
    tags: readSetting(runtime, "TAILSCALE_TAGS"),
    funnel: readSetting(runtime, "TAILSCALE_FUNNEL"),
    defaultPort: readSetting(runtime, "TAILSCALE_DEFAULT_PORT"),
    backend: normalizeBackend(readSetting(runtime, "TAILSCALE_BACKEND")),
    authKeyExpirySeconds: readSetting(
      runtime,
      "TAILSCALE_AUTH_KEY_EXPIRY_SECONDS",
    ),
    cloudApiKey: readSetting(runtime, "ELIZAOS_CLOUD_API_KEY"),
    cloudBaseUrl: readSetting(runtime, "ELIZAOS_CLOUD_BASE_URL"),
  });

  return Array.from(accounts.values());
}

export function resolveTailscaleAccount(
  accounts: readonly TailscaleAccountConfig[],
  accountId: string,
): TailscaleAccountConfig | null {
  return (
    accounts.find((account) => account.accountId === accountId) ??
    accounts.find(
      (account) => account.accountId === DEFAULT_TAILSCALE_ACCOUNT_ID,
    ) ??
    accounts[0] ??
    null
  );
}
