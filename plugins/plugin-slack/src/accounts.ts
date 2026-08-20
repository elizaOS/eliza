/**
 * Multi-account configuration model and resolution helpers for the Slack
 * connector. Defines the per-workspace `SlackAccountConfig` shape (tokens,
 * role, DM/channel/action policies) and functions that resolve an effective
 * account from either flat env vars (`SLACK_BOT_TOKEN`, …) or a structured
 * `character.settings.slack.accounts` record — `resolveSlackAccount`,
 * `listEnabledSlackAccounts`, `resolveSlackBotToken`, `normalizeAccountId`, etc.
 * `SlackService` reads these to build one runtime per workspace; the OWNER vs
 * AGENT role decides whether outbound posts use the user or bot token.
 */
import {
  type ConnectorAccountRole,
  connectorAccountCredentialSettingKey,
  connectorBaseCredentialSettingKey,
  ElizaError,
  type IAgentRuntime,
} from "@elizaos/core";
import type {
  SlackAccountConfig as CanonicalSlackAccountConfig,
  SlackChannelConfig,
  SlackDmConfig,
} from "./config";

export type {
  SlackActionConfig,
  SlackChannelConfig,
  SlackDmConfig,
  SlackReactionNotificationMode,
  SlackSlashCommandConfig,
} from "./config";

/**
 * Default account identifier used when no specific account is configured
 */
export const DEFAULT_ACCOUNT_ID = "default";

const SLACK_CREDENTIAL_KEYS = [
  "appToken",
  "botToken",
  "signingSecret",
  "userToken",
] as const;

/**
 * Source of the Slack token
 */
export type SlackTokenSource = "env" | "config" | "character" | "none";

/**
 * Configuration for a single Slack account
 */
export type SlackAccountConfig = CanonicalSlackAccountConfig & {
  /**
   * Account role. AGENT (the default) means outbound API calls are made
   * with the bot token (xoxb-) and represent the agent identity. OWNER
   * means outbound calls that have user-token coverage (chat:write user
   * scope) are made with the xoxp- user token so the agent acts as the
   * user who installed the integration.
   */
  role?: ConnectorAccountRole;
  /** Allowed channel IDs */
  allowedChannelIds?: string[];
  /** Whether to ignore bot messages */
  shouldIgnoreBotMessages?: boolean;
  /** Whether to respond only to mentions */
  shouldRespondOnlyToMentions?: boolean;
};

/**
 * Multi-account Slack configuration structure
 */
export interface SlackMultiAccountConfig extends SlackAccountConfig {
  /** Default/base configuration applied to all accounts */
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
  /**
   * Role this account represents in OWNER+AGENT terms. Drives outbound
   * API client selection in the runtime: AGENT → bot token, OWNER →
   * user token for calls covered by the granted user scopes.
   */
  role: ConnectorAccountRole;
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  userToken?: string;
  botTokenSource: SlackTokenSource;
  appTokenSource: SlackTokenSource;
  config: SlackAccountConfig;
  /**
   * Structured per-channel config for this account, hoisted out of `config`
   * so `SlackService` reads one field instead of re-deriving the merge on
   * every inbound event. Empty object when nothing is configured.
   */
  channels: Record<string, SlackChannelConfig>;
  /** Structured DM config for this account, hoisted alongside `channels`. */
  dm?: SlackDmConfig;
  /**
   * Account-level mention default, if the account sets one explicitly.
   * `undefined` means "fall through to the global env flag".
   */
  requireMention?: boolean;
  /** True when a structured authorization policy was explicitly configured. */
  hasStructuredPolicy: boolean;
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
 * Normalises an inbound role string into a `ConnectorAccountRole`.
 * Unknown values fall back to AGENT — the default for legacy single
 * bot-token deployments where the agent IS the bot.
 */
export function normalizeSlackAccountRole(raw: unknown): ConnectorAccountRole {
  if (typeof raw !== "string") return "AGENT";
  const upper = raw.trim().toUpperCase();
  if (upper === "OWNER" || upper === "AGENT" || upper === "TEAM") {
    return upper;
  }
  return "AGENT";
}

/**
 * Gets the multi-account configuration from runtime settings
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPrivateCredentials(
  runtime: IAgentRuntime,
  accountId?: string,
): SlackMultiAccountConfig {
  const result: SlackAccountConfig = {};
  for (const field of SLACK_CREDENTIAL_KEYS) {
    const key = accountId
      ? connectorAccountCredentialSettingKey("slack", accountId, field)
      : connectorBaseCredentialSettingKey("slack", field);
    const value = runtime.getSetting(key);
    if (typeof value === "string" && value.trim()) result[field] = value;
  }
  return result;
}

function getMultiAccountConfig(
  runtime: IAgentRuntime,
): SlackMultiAccountConfig {
  const characterSlack = runtime.character.settings?.slack as
    | SlackMultiAccountConfig
    | undefined;
  const publicConfig = isRecord(characterSlack) ? characterSlack : {};
  const publicAccounts = isRecord(publicConfig.accounts)
    ? publicConfig.accounts
    : {};
  const accountIds = new Set(Object.keys(publicAccounts));
  const accounts = Object.fromEntries(
    Array.from(accountIds).map((accountId) => [
      accountId,
      {
        ...(isRecord(publicAccounts[accountId])
          ? publicAccounts[accountId]
          : {}),
        ...readPrivateCredentials(runtime, accountId),
      },
    ]),
  );

  return {
    ...publicConfig,
    ...readPrivateCredentials(runtime),
    ...(accountIds.size > 0 ? { accounts } : {}),
  } as SlackMultiAccountConfig;
}

function containsStructuredPolicy(config: SlackAccountConfig): boolean {
  return [
    "allowBots",
    "requireMention",
    "groupPolicy",
    "dm",
    "channels",
    "actions",
    "commands",
    "configWrites",
    "slashCommand",
    "reactionNotifications",
    "reactionAllowlist",
  ].some((key) => Object.hasOwn(config, key));
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

  const normalizedToConfigured = new Map<string, string>();
  for (const configuredId of Object.keys(accounts)) {
    const normalized = normalizeAccountId(configuredId);
    const existing = normalizedToConfigured.get(normalized);
    if (existing !== undefined && existing !== configuredId) {
      throw new ElizaError(
        "Slack account identifiers collide after normalization",
        {
          code: "SLACK_ACCOUNT_ID_COLLISION",
          context: {
            normalizedAccountId: normalized,
            configuredIds: [existing, configuredId],
          },
        },
      );
    }
    normalizedToConfigured.set(normalized, configuredId);
  }
  const ids = Array.from(normalizedToConfigured.keys());
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

  return (
    accounts[accountId] ??
    Object.entries(accounts).find(
      ([configuredId]) => normalizeAccountId(configuredId) === accountId,
    )?.[1]
  );
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

function stripSlackCredentials<T extends SlackAccountConfig>(
  config: T,
): Partial<T> {
  const next: Partial<T> = { ...config };
  for (const key of SLACK_CREDENTIAL_KEYS) {
    delete next[key];
  }
  return next;
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
  // Filter undefined values to prevent them from overwriting defined values.
  // Named / ghost accountIds inherit policy defaults only. Owner bot, app,
  // user, and signing credentials stay on the default account so an explicit
  // unknown accountId cannot send or verify as the owner.
  const inheritedBase =
    accountId === DEFAULT_ACCOUNT_ID
      ? filterDefined(baseConfig)
      : filterDefined(stripSlackCredentials(baseConfig));

  return {
    ...filterDefined(envConfig),
    ...inheritedBase,
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
  const configuredAccount = getAccountConfig(runtime, normalizedAccountId);

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

  // Resolve signing secret. Env fallback is default-account only, matching
  // bot / app / user token inheritance.
  const envSigningSecret = allowEnv
    ? (runtime.getSetting("SLACK_SIGNING_SECRET") as string)
    : undefined;
  const signingSecret = merged.signingSecret ?? envSigningSecret;

  // Resolve user token
  const envUserToken = allowEnv
    ? resolveSlackUserToken(runtime.getSetting("SLACK_USER_TOKEN") as string)
    : undefined;
  const configUserToken = resolveSlackUserToken(merged.userToken);
  const userToken = configUserToken ?? envUserToken;

  // Resolve role. Precedence: per-account config role > env override
  // (default account only) > "AGENT". AGENT is the legacy default — the
  // agent acts as the bot identity. OWNER routes user-scope-covered
  // outbound calls through the xoxp- user token.
  const envRole = allowEnv
    ? (runtime.getSetting("SLACK_ACCOUNT_ROLE") as string | undefined)
    : undefined;
  const role = normalizeSlackAccountRole(merged.role ?? envRole);

  // Hoist the structured channel/DM config so the service can gate inbound
  // messages without walking `config` per event. Filters out null/non-object
  // entries up front — the zod schema marks each value optional, so an
  // explicit `null` reaches us intact.
  const channels: Record<string, SlackChannelConfig> = {};
  if (merged.channels && typeof merged.channels === "object") {
    for (const [channelKey, channelConfig] of Object.entries(merged.channels)) {
      if (!channelConfig || typeof channelConfig !== "object") continue;
      const trimmed = channelKey.trim();
      if (!trimmed) continue;
      channels[trimmed] = channelConfig;
    }
  }

  return {
    accountId: normalizedAccountId,
    enabled,
    name: merged.name?.trim() || undefined,
    role,
    botToken,
    appToken,
    signingSecret,
    userToken,
    botTokenSource,
    appTokenSource,
    config: merged,
    channels,
    dm: merged.dm,
    requireMention: merged.requireMention,
    hasStructuredPolicy:
      containsStructuredPolicy(multiConfig) ||
      (configuredAccount ? containsStructuredPolicy(configuredAccount) : false),
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
  const chatTypeKey =
    normalized === "direct" ||
    normalized === "group" ||
    normalized === "channel"
      ? normalized
      : undefined;

  if (
    chatTypeKey &&
    account.config.replyToModeByChatType?.[chatTypeKey] !== undefined
  ) {
    return account.config.replyToModeByChatType[chatTypeKey] ?? "off";
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
