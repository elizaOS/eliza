import type { IAgentRuntime } from "@elizaos/core";

/**
 * Default account identifier used when no specific account is configured
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Source of the Telegram token
 */
export type TelegramTokenSource = "env" | "config" | "character" | "none";

/**
 * Result of token resolution
 */
export interface TelegramTokenResolution {
  token: string;
  source: TelegramTokenSource;
}

/**
 * DM-specific configuration
 */
export interface TelegramDmConfig {
  /** If false, ignore all incoming Telegram DMs */
  enabled?: boolean;
  /** Direct message access policy */
  policy?: "open" | "disabled" | "allowlist" | "pairing";
  /** Allowlist for DM senders (ids or usernames) */
  allowFrom?: Array<string | number>;
}

/**
 * Group-specific runtime configuration (for account resolution)
 */
export interface TelegramGroupRuntimeConfig {
  /** If false, ignore all group messages */
  enabled?: boolean;
  /** Group message access policy */
  policy?: "open" | "disabled" | "allowlist";
  /** Require bot mention to respond in groups */
  requireMention?: boolean;
  /** Allowlist for groups (ids or usernames) */
  allowFrom?: Array<string | number>;
  /** User allowlist within groups */
  users?: Array<string | number>;
}

/**
 * Configuration for a single Telegram account (runtime resolution)
 */
export interface TelegramAccountRuntimeConfig {
  /** Optional display name for this account */
  name?: string;
  /** If false, do not start this Telegram account */
  enabled?: boolean;
  /** Telegram bot token for this account */
  token?: string;
  /** Update mode: polling or webhook */
  updateMode?: "polling" | "webhook";
  /** Webhook URL for webhook mode */
  webhookUrl?: string;
  /** Webhook port */
  webhookPort?: number;
  /** Webhook path */
  webhookPath?: string;
  /** Webhook secret */
  webhookSecret?: string;
  /** Custom API root URL */
  apiRoot?: string;
  /** Outbound text chunk size (chars) */
  textChunkLimit?: number;
  /** Max media size in MB */
  mediaMaxMb?: number;
  /** History limit for context */
  historyLimit?: number;
  /** DM configuration */
  dm?: TelegramDmConfig;
  /** Group configuration */
  group?: TelegramGroupRuntimeConfig;
  /** Allowed chat IDs */
  allowedChatIds?: Array<string | number>;
  /** Whether to ignore bot messages */
  shouldIgnoreBotMessages?: boolean;
}

/**
 * Multi-account Telegram configuration structure
 */
export interface TelegramMultiAccountConfig {
  /** Default/base configuration applied to all accounts */
  enabled?: boolean;
  token?: string;
  /** Per-account configuration overrides */
  accounts?: Record<string, TelegramAccountRuntimeConfig>;
}

/**
 * Resolved Telegram account with all configuration merged
 */
export interface ResolvedTelegramAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: TelegramTokenSource;
  config: TelegramAccountRuntimeConfig;
}

/**
 * Normalizes an account ID, returning the default if not provided
 */
export function normalizeAccountId(accountId?: string | null): string {
  if (!accountId || typeof accountId !== "string") {
    return DEFAULT_ACCOUNT_ID;
  }
  const trimmed = accountId.trim().toLowerCase();
  return trimmed || DEFAULT_ACCOUNT_ID;
}

/**
 * Normalizes a Telegram token by trimming whitespace
 */
export function normalizeTelegramToken(raw?: string | null): string | undefined {
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

/**
 * Gets the multi-account configuration from runtime settings
 */
export function getMultiAccountConfig(runtime: IAgentRuntime): TelegramMultiAccountConfig {
  const characterTelegram = runtime.character?.settings?.telegram as
    | TelegramMultiAccountConfig
    | undefined;

  return {
    enabled: characterTelegram?.enabled,
    token: characterTelegram?.token,
    accounts: characterTelegram?.accounts,
  };
}

/**
 * Lists all configured account IDs
 */
export function listTelegramAccountIds(runtime: IAgentRuntime): string[] {
  const config = getMultiAccountConfig(runtime);
  const accounts = config.accounts;

  if (!accounts || typeof accounts !== "object") {
    return [DEFAULT_ACCOUNT_ID];
  }

  const ids = Object.keys(accounts).filter(Boolean);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return ids.slice().sort((a, b) => a.localeCompare(b));
}

/**
 * Resolves the default account ID to use
 */
export function resolveDefaultTelegramAccountId(runtime: IAgentRuntime): string {
  const ids = listTelegramAccountIds(runtime);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Gets the account-specific configuration
 */
function getAccountConfig(
  runtime: IAgentRuntime,
  accountId: string
): TelegramAccountRuntimeConfig | undefined {
  const config = getMultiAccountConfig(runtime);
  const accounts = config.accounts;

  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }

  return accounts[accountId];
}

/**
 * Merges base configuration with account-specific overrides
 */
function mergeTelegramAccountConfig(
  runtime: IAgentRuntime,
  accountId: string
): TelegramAccountRuntimeConfig {
  const multiConfig = getMultiAccountConfig(runtime);
  const { accounts: _ignored, ...baseConfig } = multiConfig;
  const accountConfig = getAccountConfig(runtime, accountId) ?? {};

  // Get environment/runtime settings for the base config
  const envUpdateMode = runtime.getSetting("TELEGRAM_UPDATE_MODE") as string | undefined;
  const envWebhookUrl = runtime.getSetting("TELEGRAM_WEBHOOK_URL") as string | undefined;
  const envWebhookPort = runtime.getSetting("TELEGRAM_WEBHOOK_PORT") as string | undefined;
  const envWebhookPath = runtime.getSetting("TELEGRAM_WEBHOOK_PATH") as string | undefined;
  const envWebhookSecret = runtime.getSetting("TELEGRAM_WEBHOOK_SECRET") as string | undefined;
  const envApiRoot = runtime.getSetting("TELEGRAM_API_ROOT") as string | undefined;
  const envAllowedChats = runtime.getSetting("TELEGRAM_ALLOWED_CHATS") as string | undefined;

  const envConfig: TelegramAccountRuntimeConfig = {
    updateMode: envUpdateMode === "webhook" ? "webhook" : "polling",
    webhookUrl: envWebhookUrl || undefined,
    webhookPort: envWebhookPort ? parseInt(envWebhookPort, 10) : undefined,
    webhookPath: envWebhookPath || undefined,
    webhookSecret: envWebhookSecret || undefined,
    apiRoot: envApiRoot || undefined,
    allowedChatIds: envAllowedChats
      ? envAllowedChats
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  };

  // Merge order: env defaults < base config < account config
  return {
    ...envConfig,
    ...baseConfig,
    ...accountConfig,
  };
}

/**
 * Resolves the Telegram token for a specific account
 */
export function resolveTelegramToken(
  runtime: IAgentRuntime,
  opts: { accountId?: string | null } = {}
): TelegramTokenResolution {
  const accountId = normalizeAccountId(opts.accountId);
  const multiConfig = getMultiAccountConfig(runtime);

  // Check account-specific token first
  const accountConfig =
    accountId !== DEFAULT_ACCOUNT_ID
      ? multiConfig.accounts?.[accountId]
      : multiConfig.accounts?.[DEFAULT_ACCOUNT_ID];

  const accountToken = normalizeTelegramToken(accountConfig?.token);
  if (accountToken) {
    return { token: accountToken, source: "config" };
  }

  // For default account, check base config token
  const allowBase = accountId === DEFAULT_ACCOUNT_ID;
  const baseToken = allowBase ? normalizeTelegramToken(multiConfig.token) : undefined;
  if (baseToken) {
    return { token: baseToken, source: "character" };
  }

  // For default account, check environment token
  const envToken = allowBase
    ? normalizeTelegramToken(runtime.getSetting("TELEGRAM_BOT_TOKEN") as string)
    : undefined;
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}

/**
 * Resolves a complete Telegram account configuration
 */
export function resolveTelegramAccount(
  runtime: IAgentRuntime,
  accountId?: string | null
): ResolvedTelegramAccount {
  const normalizedAccountId = normalizeAccountId(accountId);
  const multiConfig = getMultiAccountConfig(runtime);

  const baseEnabled = multiConfig.enabled !== false;
  const merged = mergeTelegramAccountConfig(runtime, normalizedAccountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const tokenResolution = resolveTelegramToken(runtime, { accountId: normalizedAccountId });

  return {
    accountId: normalizedAccountId,
    enabled,
    name: merged.name?.trim() || undefined,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: merged,
  };
}

/**
 * Lists all enabled Telegram accounts
 */
export function listEnabledTelegramAccounts(runtime: IAgentRuntime): ResolvedTelegramAccount[] {
  return listTelegramAccountIds(runtime)
    .map((accountId) => resolveTelegramAccount(runtime, accountId))
    .filter((account) => account.enabled && account.token);
}

/**
 * Checks if multi-account mode is enabled
 */
export function isMultiAccountEnabled(runtime: IAgentRuntime): boolean {
  const accounts = listEnabledTelegramAccounts(runtime);
  return accounts.length > 1;
}
