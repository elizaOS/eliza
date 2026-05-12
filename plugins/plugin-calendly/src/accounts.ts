import type { IAgentRuntime } from "@elizaos/core";

export const DEFAULT_CALENDLY_ACCOUNT_ID = "default";

export interface CalendlyAccountConfig {
  accountId: string;
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

export function normalizeCalendlyAccountId(value: unknown): string {
  return nonEmptyString(value) ?? DEFAULT_CALENDLY_ACCOUNT_ID;
}

export function resolveCalendlyAccountId(
  runtime: IAgentRuntime,
  options?: Record<string, unknown>,
): string {
  return normalizeCalendlyAccountId(
    options?.accountId ??
      options?.calendlyAccountId ??
      readSetting(runtime, "CALENDLY_DEFAULT_ACCOUNT_ID") ??
      readSetting(runtime, "CALENDLY_ACCOUNT_ID"),
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
): CalendlyAccountConfig | null {
  const accountId = normalizeCalendlyAccountId(
    record.accountId ?? record.id ?? record.name,
  );
  const accessToken = readRawField(record, [
    "CALENDLY_ACCESS_TOKEN",
    "accessToken",
    "token",
    "access",
  ]);
  if (!accessToken) return null;
  return {
    accountId,
    accessToken,
    label: nonEmptyString(record.label ?? record.displayName),
  };
}

function addAccount(
  accounts: Map<string, CalendlyAccountConfig>,
  account: CalendlyAccountConfig | null,
): void {
  if (account) {
    accounts.set(account.accountId, account);
  }
}

export function readCalendlyAccounts(
  runtime: IAgentRuntime,
): CalendlyAccountConfig[] {
  const accounts = new Map<string, CalendlyAccountConfig>();
  const characterConfig = runtime.character?.settings?.calendly as
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
    readSetting(runtime, "CALENDLY_ACCOUNTS"),
  )) {
    addAccount(accounts, accountFromRecord(record));
  }

  const accessToken =
    readSetting(runtime, "CALENDLY_ACCESS_TOKEN") ??
    readSetting(runtime, "ELIZA_E2E_CALENDLY_ACCESS_TOKEN");
  if (accessToken) {
    addAccount(accounts, {
      accountId: normalizeCalendlyAccountId(
        readSetting(runtime, "CALENDLY_ACCOUNT_ID") ??
          readSetting(runtime, "CALENDLY_DEFAULT_ACCOUNT_ID"),
      ),
      accessToken,
    });
  }

  return Array.from(accounts.values());
}

export function resolveCalendlyAccount(
  accounts: readonly CalendlyAccountConfig[],
  accountId: string,
): CalendlyAccountConfig | null {
  return (
    accounts.find((account) => account.accountId === accountId) ??
    accounts.find(
      (account) => account.accountId === DEFAULT_CALENDLY_ACCOUNT_ID,
    ) ??
    accounts[0] ??
    null
  );
}

export const calendlyAccountIdParameter = {
  name: "accountId",
  description:
    "Optional Calendly account id from CALENDLY_ACCOUNTS. Defaults to CALENDLY_DEFAULT_ACCOUNT_ID or the legacy single access token.",
  required: false,
  schema: { type: "string" as const },
};
