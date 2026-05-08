import type { IAgentRuntime } from "@elizaos/core";

export const DEFAULT_SHOPIFY_ACCOUNT_ID = "default";

export interface ShopifyAccountConfig {
  accountId: string;
  storeDomain: string;
  accessToken: string;
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

export function normalizeShopifyAccountId(value: unknown): string {
  return nonEmptyString(value) ?? DEFAULT_SHOPIFY_ACCOUNT_ID;
}

export function resolveShopifyAccountId(
  runtime: IAgentRuntime,
  options?: Record<string, unknown>,
): string {
  return normalizeShopifyAccountId(
    options?.accountId ??
      options?.shopifyAccountId ??
      readSetting(runtime, "SHOPIFY_DEFAULT_ACCOUNT_ID") ??
      readSetting(runtime, "SHOPIFY_ACCOUNT_ID"),
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

function accountFromRecord(
  record: RawAccountRecord,
): ShopifyAccountConfig | null {
  const accountId = normalizeShopifyAccountId(
    record.accountId ?? record.id ?? record.name,
  );
  const storeDomain = readRawField(record, [
    "SHOPIFY_STORE_DOMAIN",
    "storeDomain",
    "domain",
  ]);
  const accessToken = readRawField(record, [
    "SHOPIFY_ACCESS_TOKEN",
    "accessToken",
    "token",
    "access",
  ]);
  if (!storeDomain || !accessToken) return null;
  return {
    accountId,
    storeDomain,
    accessToken,
    label: nonEmptyString(record.label ?? record.displayName),
  };
}

function addAccount(
  accounts: Map<string, ShopifyAccountConfig>,
  account: ShopifyAccountConfig | null,
): void {
  if (account) {
    accounts.set(account.accountId, account);
  }
}

export function readShopifyAccounts(
  runtime: IAgentRuntime,
): ShopifyAccountConfig[] {
  const accounts = new Map<string, ShopifyAccountConfig>();
  const characterConfig = runtime.character?.settings?.shopify as
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
    readSetting(runtime, "SHOPIFY_ACCOUNTS"),
  )) {
    addAccount(accounts, accountFromRecord(record));
  }

  const storeDomain = readSetting(runtime, "SHOPIFY_STORE_DOMAIN");
  const accessToken = readSetting(runtime, "SHOPIFY_ACCESS_TOKEN");
  if (storeDomain && accessToken) {
    addAccount(accounts, {
      accountId: normalizeShopifyAccountId(
        readSetting(runtime, "SHOPIFY_ACCOUNT_ID") ??
          readSetting(runtime, "SHOPIFY_DEFAULT_ACCOUNT_ID"),
      ),
      storeDomain,
      accessToken,
    });
  }

  return Array.from(accounts.values());
}

export function resolveShopifyAccount(
  accounts: readonly ShopifyAccountConfig[],
  accountId: string,
): ShopifyAccountConfig | null {
  return (
    accounts.find((account) => account.accountId === accountId) ??
    accounts.find((account) => account.accountId === DEFAULT_SHOPIFY_ACCOUNT_ID) ??
    accounts[0] ??
    null
  );
}

export function hasShopifyAccountConfig(
  runtime: IAgentRuntime,
  options?: Record<string, unknown>,
): boolean {
  const accountId = resolveShopifyAccountId(runtime, options);
  return Boolean(resolveShopifyAccount(readShopifyAccounts(runtime), accountId));
}
