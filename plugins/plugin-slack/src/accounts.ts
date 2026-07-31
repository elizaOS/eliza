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
import type { ConnectorAccountRole, IAgentRuntime } from "@elizaos/core";

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
  /**
   * Direct message access policy. Mirrors `DmPolicySchema`, which INCLUDES
   * `pairing` — the schema's default once a `dm` block exists. The service
   * implements no pairing handshake, so `pairing` fails closed with a loud
   * startup warning rather than silently admitting every DM.
   */
  policy?: "pairing" | "open" | "disabled" | "allowlist";
  /** Allowlist for DM senders (ids or names) */
  allowFrom?: Array<string | number>;
  /** Whether multi-person DMs (mpim) are processed */
  groupEnabled?: boolean;
  /** Explicit mpim allowlist (ids or names) */
  groupChannels?: Array<string | number>;
  /** Reply-to mode for DMs */
  replyToMode?: "off" | "first" | "all";
}

/**
 * Channel-specific configuration.
 *
 * MIRRORS `SlackChannelSchema` in
 * `packages/agent/src/config/zod-schema.providers-core.ts` EXACTLY. That schema
 * is `.strict()`, so a field here the schema does not accept can never arrive
 * through the production config path (it was an invention), and a schema field
 * missing here is a policy the operator wrote that the service silently
 * discards. Both directions are bugs; keep the two in lockstep.
 *
 * `tools` / `toolsBySender` are declared because the schema accepts them, but
 * the service does NOT enforce per-channel tool authorization — configuring
 * them fails startup in `assertSlackPolicySupported()` rather than pretending
 * an authorization boundary exists. `skills` / `systemPrompt` are resolved but
 * not yet applied to message context; they raise a startup warning.
 */
export interface SlackChannelConfig {
  /** If false, ignore this channel */
  enabled?: boolean;
  /** Legacy alias for `enabled: false`. */
  allow?: boolean;
  /** Require bot mention to respond */
  requireMention?: boolean;
  /** Per-channel tool policy. NOT enforced — configuring it fails startup. */
  tools?: unknown;
  /** Per-sender tool policy. NOT enforced — configuring it fails startup. */
  toolsBySender?: unknown;
  /** Allow bot-authored messages to trigger replies in this channel */
  allowBots?: boolean;
  /** User allowlist for this channel */
  users?: Array<string | number>;
  /** Skill filter for this channel. Resolved, not yet applied. */
  skills?: string[];
  /** System prompt for this channel. Resolved, not yet applied. */
  systemPrompt?: string;
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
  /**
   * Account role. AGENT (the default) means outbound API calls are made
   * with the bot token (xoxb-) and represent the agent identity. OWNER
   * means outbound calls that have user-token coverage (chat:write user
   * scope) are made with the xoxp- user token so the agent acts as the
   * user who installed the integration.
   */
  role?: ConnectorAccountRole;
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
  /** Slash command configuration. NOT implemented; warns at startup. */
  slashCommand?: SlackSlashCommandConfig;
  /**
   * Ingress mode. The service hardcodes Socket Mode; `"http"` FAILS startup
   * rather than letting an operator believe a signing secret is validating
   * requests that never arrive over HTTP.
   */
  mode?: "socket" | "http";
  /** Account-level bot-message policy, overridden per channel. */
  allowBots?: boolean;
  /** DM configuration */
  dm?: SlackDmConfig;
  /**
   * Per-channel configuration, keyed by channel ID (`C0123ABCD`), by channel
   * name (`general`, matched once the name is known), or `"*"` for a default.
   */
  channels?: Record<string, SlackChannelConfig>;
  /**
   * Account-level default mention requirement for channel messages. Overridden
   * per channel by `channels.<id>.requireMention`; overrides the global
   * `SLACK_SHOULD_RESPOND_ONLY_TO_MENTIONS` env flag.
   */
  requireMention?: boolean;
  /** Allowed channel IDs */
  allowedChannelIds?: string[];
  /** Whether to ignore bot messages */
  shouldIgnoreBotMessages?: boolean;
  /** Whether to respond only to mentions */
  shouldRespondOnlyToMentions?: boolean;
}

/**
 * Multi-account Slack configuration structure.
 *
 * `SlackConfigSchema` is literally `SlackAccountSchema.extend({accounts})`:
 * every top-level key IS an account key, acting as the base config that
 * per-account entries override. Modelling that as `SlackAccountConfig &
 * {accounts}` is what makes top-level `channels` / `dm` / `groupPolicy` /
 * `requireMention` reach the gate at all — the previous shape kept only
 * `enabled`, `botToken`, `appToken` and `accounts`, so the DOCUMENTED
 * single-workspace config (`connectors.slack.channels.C0123ABCD.enabled=false`)
 * was dropped on the floor before any policy could see it.
 */
export interface SlackMultiAccountConfig extends SlackAccountConfig {
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
 * Gets the multi-account configuration from runtime settings.
 *
 * Reads `character.settings.slack` WHOLE. The previous implementation
 * hand-picked four keys (`enabled`, `botToken`, `appToken`, `accounts`) and
 * discarded everything else, which meant the entire documented top-level
 * policy surface — `channels`, `dm`, `groupPolicy`, `requireMention`,
 * `allowBots` — never reached the gate no matter how it was configured. Since
 * `SlackConfigSchema` is `SlackAccountSchema.extend({accounts})`, the top level
 * IS an account config; passing it through verbatim is both correct and the
 * only way the schema's own shape can be honored.
 */
export function getMultiAccountConfig(
  runtime: IAgentRuntime,
): SlackMultiAccountConfig {
  const characterSlack = runtime.character?.settings?.slack as
    | SlackMultiAccountConfig
    | undefined;

  if (!characterSlack || typeof characterSlack !== "object") {
    return {};
  }
  return { ...characterSlack };
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

  const ids = Array.from(
    new Set(
      Object.keys(accounts)
        .map((id) => normalizeAccountId(id))
        .filter(Boolean),
    ),
  );
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
