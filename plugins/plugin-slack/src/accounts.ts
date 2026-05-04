import type { IAgentRuntime } from "@elizaos/core";

/**
 * Default account identifier used when no specific account is configured
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Source of the Slack token
 */
export type SlackTokenSource = "env" | "config" | "character" | "none";

/**
 * DM-specific configuration
 */
export interface SlackDmConfig {
  /** If false, ignore all incoming Slack DMs */
  enabled?: boolean;
  /** Direct message access policy */
  policy?: "open" | "disabled" | "allowlist";
  /** Allowlist for DM senders (ids or names) */
  allowFrom?: Array<string | number>;
  /** Reply-to mode for DMs */
  replyToMode?: "off" | "first" | "all";
}

/**
 * Channel-specific configuration
 */
export interface SlackChannelConfig {
  /** If false, ignore this channel */
  enabled?: boolean;
  /** Require bot mention to respond */
  requireMention?: boolean;
  /** User allowlist for this channel */
  users?: Array<string | number>;
  /** Reply-to mode for this channel */
  replyToMode?: "off" | "first" | "all";
}

/**
 * Reaction notification mode
 */
export type SlackReactionNotificationMode = "off" | "own" | "all" | "allowlist";

/**
 * Slash command configuration
 */
export interface SlackSlashCommandConfig {
  /** Enable slash commands */
  enabled?: boolean;
  /** Slash command name (without leading /) */
  command?: string;
}

/**
 * Action toggles for Slack features
 */
export interface SlackActionConfig {
  /** Enable reactions */
  reactions?: boolean;
  /** Enable pins */
  pins?: boolean;
  /** Enable file uploads */
  files?: boolean;
  /** Enable message editing */
  edit?: boolean;
  /** Enable message deletion */
  delete?: boolean;
  /** Enable emoji list */
  emojiList?: boolean;
  /** Enable member info */
  memberInfo?: boolean;
}

/**
 * Configuration for a single Slack account
 */
export interface SlackAccountConfig {
  /** Optional display name for this account */
  name?: string;
  /** If false, do not start this Slack account */
  enabled?: boolean;
  /** Slack bot token (xoxb-...) */
  botToken?: string;
  /** Slack app-level token (xapp-...) */
  appToken?: string;
  /** Slack signing secret */
  signingSecret?: string;
  /** Slack user token (xoxp-...) for user actions */
  userToken?: string;
  /** Controls how channel messages are handled */
  groupPolicy?: "open" | "disabled" | "allowlist";
  /** Outbound text chunk size (chars) */
  textChunkLimit?: number;
  /** Max media size in MB */
  mediaMaxMb?: number;
  /** Reaction notification mode */
  reactionNotifications?: SlackReactionNotificationMode;
  /** Reaction allowlist when mode is 'allowlist' */
  reactionAllowlist?: Array<string | number>;
  /** Reply-to mode */
  replyToMode?: "off" | "first" | "all";
  /** Reply-to mode by chat type */
  replyToModeByChatType?: Record<string, "off" | "first" | "all">;
  /** Per-action toggles */
  actions?: SlackActionConfig;
  /** Slash command configuration */
  slashCommand?: SlackSlashCommandConfig;
  /** DM configuration */
  dm?: SlackDmConfig;
  /** Per-channel configuration keyed by channel ID */
  channels?: Record<string, SlackChannelConfig>;
  /** Allowed channel IDs */
  allowedChannelIds?: string[];
  /** Whether to ignore bot messages */
  shouldIgnoreBotMessages?: boolean;
  /** Whether to respond only to mentions */
  shouldRespondOnlyToMentions?: boolean;
}

/**
 * Multi-account Slack configuration structure
 */
export interface SlackMultiAccountConfig {
  /** Default/base configuration applied to all accounts */
  enabled?: boolean;
  botToken?: string;
  appToken?: string;
  /** Per-account configuration overrides */
  accounts?: Record<string, SlackAccountConfig>;
}

/**
 * Resolved Slack account with all configuration merged
 */
export interface ResolvedSlackAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  config: SlackAccountConfig;
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
 * Validates and normalizes a Slack token with the expected prefix
 */
function normalizeSlackToken(
  raw: string | null | undefined,
  prefix: string,
): string | undefined {
  const trimmed = raw?.trim();
  return trimmed?.startsWith(prefix) ? trimmed : undefined;
}

/**
 * Validates and normalizes a Slack bot token (xoxb-)
 */
export function resolveSlackBotToken(raw?: string | null): string | undefined {
  return normalizeSlackToken(raw, "xoxb-");
}

/**
 * Validates and normalizes a Slack app token (xapp-)
 */
export function resolveSlackAppToken(raw?: string | null): string | undefined {
  return normalizeSlackToken(raw, "xapp-");
}

/**
 * Validates and normalizes a Slack user token (xoxp-)
 */
export function resolveSlackUserToken(raw?: string | null): string | undefined {
  return normalizeSlackToken(raw, "xoxp-");
}

/**
 * Gets the multi-account configuration from runtime settings
 */
export function getMultiAccountConfig(
  runtime: IAgentRuntime,
): SlackMultiAccountConfig {
  const characterSlack = runtime.character?.settings?.slack as
    | SlackMultiAccountConfig
    | undefined;

  return {
    enabled: characterSlack?.enabled,
    botToken: characterSlack?.botToken,
    appToken: characterSlack?.appToken,
    accounts: characterSlack?.accounts,
  };
}

/**
 * Lists all configured account IDs
 */
export function listSlackAccountIds(runtime: IAgentRuntime): string[] {
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
export function resolveDefaultSlackAccountId(runtime: IAgentRuntime): string {
  const ids = listSlackAccountIds(runtime);
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
  accountId: string,
): SlackAccountConfig | undefined {
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
/**
 * Removes undefined values from an object to prevent them from overwriting during spread
 */
function filterDefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function mergeSlackAccountConfig(
  runtime: IAgentRuntime,
  accountId: string,
): SlackAccountConfig {
  const multiConfig = getMultiAccountConfig(runtime);
  const { accounts: _ignored, ...baseConfig } = multiConfig;
  const accountConfig = getAccountConfig(runtime, accountId) ?? {};

  // Get environment/runtime settings for the base config
  const envChannelIds = runtime.getSetting("SLACK_CHANNEL_IDS") as
    | string
    | undefined;

  const envConfig: SlackAccountConfig = {
    shouldIgnoreBotMessages:
      (
        runtime.getSetting("SLACK_SHOULD_IGNORE_BOT_MESSAGES") as string
      )?.toLowerCase() === "true",
    shouldRespondOnlyToMentions:
      (
        runtime.getSetting("SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS") as string
      )?.toLowerCase() === "true",
    allowedChannelIds: envChannelIds
      ? envChannelIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
  };

  // Merge order: env defaults < base config < account config
  // Filter undefined values to prevent them from overwriting defined values
  return {
    ...filterDefined(envConfig),
    ...filterDefined(baseConfig),
    ...filterDefined(accountConfig),
  };
}

/**
 * Resolves a complete Slack account configuration
 */
export function resolveSlackAccount(
  runtime: IAgentRuntime,
  accountId?: string | null,
): ResolvedSlackAccount {
  const normalizedAccountId = normalizeAccountId(accountId);
  const multiConfig = getMultiAccountConfig(runtime);

  const baseEnabled = multiConfig.enabled !== false;
  const merged = mergeSlackAccountConfig(runtime, normalizedAccountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const allowEnv = normalizedAccountId === DEFAULT_ACCOUNT_ID;

  // Resolve bot token
  const envBotToken = allowEnv
    ? resolveSlackBotToken(runtime.getSetting("SLACK_BOT_TOKEN") as string)
    : undefined;
  const configBotToken = resolveSlackBotToken(merged.botToken);
  const botToken = configBotToken ?? envBotToken;
  const botTokenSource: SlackTokenSource = configBotToken
    ? "config"
    : envBotToken
      ? "env"
      : "none";

  // Resolve app token
  const envAppToken = allowEnv
    ? resolveSlackAppToken(runtime.getSetting("SLACK_APP_TOKEN") as string)
    : undefined;
  const configAppToken = resolveSlackAppToken(merged.appToken);
  const appToken = configAppToken ?? envAppToken;
  const appTokenSource: SlackTokenSource = configAppToken
    ? "config"
    : envAppToken
      ? "env"
      : "none";

  // Resolve signing secret
  const signingSecret =
    merged.signingSecret ??
    (runtime.getSetting("SLACK_SIGNING_SECRET") as string);

  // Resolve user token
  const envUserToken = allowEnv
    ? resolveSlackUserToken(runtime.getSetting("SLACK_USER_TOKEN") as string)
    : undefined;
  const configUserToken = resolveSlackUserToken(merged.userToken);
  const userToken = configUserToken ?? envUserToken;

  return {
    accountId: normalizedAccountId,
    enabled,
    name: merged.name?.trim() || undefined,
    botToken,
    appToken,
    signingSecret,
    userToken,
    botTokenSource,
    appTokenSource,
    config: merged,
  };
}

/**
 * Lists all enabled Slack accounts
 */
export function listEnabledSlackAccounts(
  runtime: IAgentRuntime,
): ResolvedSlackAccount[] {
  return listSlackAccountIds(runtime)
    .map((accountId) => resolveSlackAccount(runtime, accountId))
    .filter((account) => account.enabled && account.botToken);
}

/**
 * Checks if multi-account mode is enabled
 */
export function isMultiAccountEnabled(runtime: IAgentRuntime): boolean {
  const accounts = listEnabledSlackAccounts(runtime);
  return accounts.length > 1;
}

/**
 * Resolves the reply-to mode for a specific chat type
 */
export function resolveSlackReplyToMode(
  account: ResolvedSlackAccount,
  chatType?: string | null,
): "off" | "first" | "all" {
  const normalized = chatType?.toLowerCase().trim();

  // Check chat type specific override
  if (
    normalized &&
    account.config.replyToModeByChatType?.[normalized] !== undefined
  ) {
    return account.config.replyToModeByChatType[normalized] ?? "off";
  }

  // Check DM-specific setting
  if (normalized === "direct" || normalized === "im") {
    if (account.config.dm?.replyToMode !== undefined) {
      return account.config.dm.replyToMode;
    }
  }

  // Fall back to global setting
  return account.config.replyToMode ?? "off";
}
