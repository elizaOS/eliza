import type { IAgentRuntime } from "@elizaos/core";

export const DEFAULT_ACCOUNT_ID = "default";

export interface TelegramAccountConfig {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  apiRoot?: string;
  allowedChats?: string[];
  autoReply?: boolean;
  personal?: {
    phone?: string;
    appId?: string;
    appHash?: string;
    session?: string;
    enabled?: boolean;
  };
}

export interface TelegramMultiAccountConfig {
  enabled?: boolean;
  botToken?: string;
  apiRoot?: string;
  accounts?: Record<string, TelegramAccountConfig>;
}

export interface ResolvedTelegramAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  apiRoot: string;
  config: TelegramAccountConfig;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeTelegramAccountId(accountId?: string | null): string {
  return readNonEmptyString(accountId) ?? DEFAULT_ACCOUNT_ID;
}

export function getTelegramMultiAccountConfig(
  runtime: IAgentRuntime,
): TelegramMultiAccountConfig {
  const characterTelegram = runtime.character?.settings?.telegram as
    | TelegramMultiAccountConfig
    | undefined;

  return {
    enabled: characterTelegram?.enabled,
    botToken: characterTelegram?.botToken,
    apiRoot: characterTelegram?.apiRoot,
    accounts: characterTelegram?.accounts,
  };
}

export function listTelegramAccountIds(runtime: IAgentRuntime): string[] {
  const accounts = getTelegramMultiAccountConfig(runtime).accounts;
  if (!accounts || typeof accounts !== "object") {
    return [DEFAULT_ACCOUNT_ID];
  }
  const ids = Object.keys(accounts).filter(Boolean);
  return ids.length > 0
    ? ids.slice().sort((a, b) => a.localeCompare(b))
    : [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultTelegramAccountId(
  runtime: IAgentRuntime,
): string {
  const ids = listTelegramAccountIds(runtime);
  return ids.includes(DEFAULT_ACCOUNT_ID)
    ? DEFAULT_ACCOUNT_ID
    : (ids[0] ?? DEFAULT_ACCOUNT_ID);
}

function getAccountConfig(
  runtime: IAgentRuntime,
  accountId: string,
): TelegramAccountConfig | undefined {
  const accounts = getTelegramMultiAccountConfig(runtime).accounts;
  return accounts && typeof accounts === "object"
    ? accounts[accountId]
    : undefined;
}

function resolveTelegramBotToken(
  runtime: IAgentRuntime,
  accountId: string,
  merged: TelegramAccountConfig,
): string | undefined {
  const configToken = readNonEmptyString(merged.botToken);
  if (configToken) {
    return configToken;
  }
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return undefined;
  }
  return (
    readNonEmptyString(runtime.getSetting("TELEGRAM_BOT_TOKEN")) ??
    readNonEmptyString(process.env.TELEGRAM_BOT_TOKEN)
  );
}

export function resolveTelegramAccount(
  runtime: IAgentRuntime,
  accountId?: string | null,
): ResolvedTelegramAccount {
  const normalizedAccountId = normalizeTelegramAccountId(accountId);
  const multi = getTelegramMultiAccountConfig(runtime);
  const accountConfig = getAccountConfig(runtime, normalizedAccountId) ?? {};
  const merged: TelegramAccountConfig = {
    enabled: multi.enabled,
    botToken: multi.botToken,
    apiRoot: multi.apiRoot,
    ...accountConfig,
  };
  const apiRoot =
    readNonEmptyString(merged.apiRoot) ??
    readNonEmptyString(runtime.getSetting("TELEGRAM_API_ROOT")) ??
    readNonEmptyString(process.env.TELEGRAM_API_ROOT) ??
    "https://api.telegram.org";

  return {
    accountId: normalizedAccountId,
    enabled: multi.enabled !== false && merged.enabled !== false,
    name: readNonEmptyString(merged.name),
    botToken: resolveTelegramBotToken(runtime, normalizedAccountId, merged),
    apiRoot,
    config: merged,
  };
}

export function listEnabledTelegramAccounts(
  runtime: IAgentRuntime,
): ResolvedTelegramAccount[] {
  return listTelegramAccountIds(runtime)
    .map((accountId) => resolveTelegramAccount(runtime, accountId))
    .filter((account) => account.enabled && account.botToken);
}
