import type { IAgentRuntime } from "@elizaos/core";

/**
 * Default account identifier used when no specific account is configured
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Source of the Discord token
 */
export type DiscordTokenSource = "env" | "config" | "character" | "none";

/**
 * Result of token resolution
 */
export interface DiscordTokenResolution {
	token: string;
	source: DiscordTokenSource;
}

/**
 * Configuration for a single Discord account
 */
export interface DiscordAccountConfig {
	/** Optional display name for this account */
	name?: string;
	/** If false, do not start this Discord account */
	enabled?: boolean;
	/** Discord bot token for this account */
	token?: string;
	/** Allow bot-authored messages to trigger replies */
	allowBots?: boolean;
	/** Controls how guild channel messages are handled */
	groupPolicy?: "open" | "disabled" | "allowlist";
	/** Outbound text chunk size (chars) */
	textChunkLimit?: number;
	/** Max lines per message */
	maxLinesPerMessage?: number;
	/** Max media size in MB */
	mediaMaxMb?: number;
	/** History limit for context */
	historyLimit?: number;
	/** Max DM turns to keep as history context */
	dmHistoryLimit?: number;
	/** DM configuration */
	dm?: DiscordDmConfig;
	/** Per-guild configuration */
	guilds?: Record<string, DiscordGuildEntry>;
	/** Channel IDs to allow */
	channelIds?: string[];
	/** Listen-only channel IDs */
	listenChannelIds?: string[];
	/** Whether to ignore bot messages */
	shouldIgnoreBotMessages?: boolean;
	/** Whether to ignore direct messages */
	shouldIgnoreDirectMessages?: boolean;
	/** Whether to respond only to mentions */
	shouldRespondOnlyToMentions?: boolean;
}

/**
 * DM-specific configuration
 */
export interface DiscordDmConfig {
	/** If false, ignore all incoming Discord DMs */
	enabled?: boolean;
	/** Direct message access policy */
	policy?: "open" | "disabled" | "allowlist" | "pairing";
	/** Allowlist for DM senders (ids or names) */
	allowFrom?: Array<string | number>;
	/** If true, allow group DMs */
	groupEnabled?: boolean;
	/** Optional allowlist for group DM channels */
	groupChannels?: Array<string | number>;
}

/**
 * Channel-specific configuration within a guild
 */
export interface DiscordGuildChannelConfig {
	/** Whether this channel is allowed */
	allow?: boolean;
	/** Require bot mention to respond */
	requireMention?: boolean;
	/** Skills to load for this channel */
	skills?: string[];
	/** If false, disable the bot for this channel */
	enabled?: boolean;
	/** Allowlist for channel senders */
	users?: Array<string | number>;
	/** System prompt snippet for this channel */
	systemPrompt?: string;
	/** Auto-create threads for replies */
	autoThread?: boolean;
}

/**
 * Guild-level configuration
 */
export interface DiscordGuildEntry {
	/** Guild slug for name-based matching */
	slug?: string;
	/** Require bot mention to respond */
	requireMention?: boolean;
	/** Reaction notification mode */
	reactionNotifications?: "off" | "own" | "all" | "allowlist";
	/** Allowlist for guild users */
	users?: Array<string | number>;
	/** Per-channel configuration */
	channels?: Record<string, DiscordGuildChannelConfig>;
}

/**
 * Multi-account Discord configuration structure
 */
export interface DiscordMultiAccountConfig {
	/** Default/base configuration applied to all accounts */
	enabled?: boolean;
	token?: string;
	/** Per-account configuration overrides */
	accounts?: Record<string, DiscordAccountConfig>;
}

/**
 * Resolved Discord account with all configuration merged
 */
export interface ResolvedDiscordAccount {
	accountId: string;
	enabled: boolean;
	name?: string;
	token: string;
	tokenSource: DiscordTokenSource;
	config: DiscordAccountConfig;
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
 * Normalizes a Discord token by trimming and removing "Bot " prefix
 */
export function normalizeDiscordToken(raw?: string | null): string | undefined {
	const trimmed = raw?.trim();
	return trimmed ? trimmed.replace(/^Bot\s+/i, "") : undefined;
}

/**
 * Gets the multi-account configuration from runtime settings
 */
export function getMultiAccountConfig(
	runtime: IAgentRuntime,
): DiscordMultiAccountConfig {
	const characterDiscord = runtime.character?.settings?.discord as
		| DiscordMultiAccountConfig
		| undefined;

	return {
		enabled: characterDiscord?.enabled,
		token: characterDiscord?.token,
		accounts: characterDiscord?.accounts,
	};
}

/**
 * Lists all configured account IDs
 */
export function listDiscordAccountIds(runtime: IAgentRuntime): string[] {
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
export function resolveDefaultDiscordAccountId(runtime: IAgentRuntime): string {
	const ids = listDiscordAccountIds(runtime);
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
): DiscordAccountConfig | undefined {
	const config = getMultiAccountConfig(runtime);
	const accounts = config.accounts;

	if (!accounts || typeof accounts !== "object") {
		return undefined;
	}

	return accounts[accountId];
}

/**
 * Removes undefined values from an object to prevent them from overwriting during spread
 */
function filterDefined<T extends object>(obj: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(obj).filter(([, v]) => v !== undefined),
	) as Partial<T>;
}

function parseOptionalBooleanSetting(
	runtime: IAgentRuntime,
	key: string,
): boolean | undefined {
	const value = runtime.getSetting(key);
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value === "boolean") {
		return value;
	}
	const normalized = String(value).trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	if (normalized === "true" || normalized === "1") {
		return true;
	}
	if (normalized === "false" || normalized === "0") {
		return false;
	}
	return undefined;
}

/**
 * Merges base configuration with account-specific overrides
 */
function mergeDiscordAccountConfig(
	runtime: IAgentRuntime,
	accountId: string,
): DiscordAccountConfig {
	const multiConfig = getMultiAccountConfig(runtime);
	const { accounts: _ignored, ...baseConfig } = multiConfig;
	const accountConfig = getAccountConfig(runtime, accountId) ?? {};

	// Get environment/runtime settings for the base config
	const envChannelIds = runtime.getSetting("CHANNEL_IDS") as string | undefined;
	const envListenChannelIds = runtime.getSetting(
		"DISCORD_LISTEN_CHANNEL_IDS",
	) as string | undefined;

	const envConfig: DiscordAccountConfig = {
		shouldIgnoreBotMessages: parseOptionalBooleanSetting(
			runtime,
			"DISCORD_SHOULD_IGNORE_BOT_MESSAGES",
		),
		shouldIgnoreDirectMessages: parseOptionalBooleanSetting(
			runtime,
			"DISCORD_SHOULD_IGNORE_DIRECT_MESSAGES",
		),
		shouldRespondOnlyToMentions: parseOptionalBooleanSetting(
			runtime,
			"DISCORD_SHOULD_RESPOND_ONLY_TO_MENTIONS",
		),
		channelIds: envChannelIds
			? envChannelIds
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: undefined,
		listenChannelIds: envListenChannelIds
			? envListenChannelIds
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
 * Resolves the Discord token for a specific account
 */
export function resolveDiscordToken(
	runtime: IAgentRuntime,
	opts: { accountId?: string | null } = {},
): DiscordTokenResolution {
	const accountId = normalizeAccountId(opts.accountId);
	const multiConfig = getMultiAccountConfig(runtime);

	// Check account-specific token first
	const accountConfig =
		accountId !== DEFAULT_ACCOUNT_ID
			? multiConfig.accounts?.[accountId]
			: multiConfig.accounts?.[DEFAULT_ACCOUNT_ID];

	const accountToken = normalizeDiscordToken(accountConfig?.token);
	if (accountToken) {
		return { token: accountToken, source: "config" };
	}

	// For default account, check base config token
	const allowBase = accountId === DEFAULT_ACCOUNT_ID;
	const baseToken = allowBase
		? normalizeDiscordToken(multiConfig.token)
		: undefined;
	if (baseToken) {
		return { token: baseToken, source: "character" };
	}

	// For default account, check environment token
	const envToken = allowBase
		? normalizeDiscordToken(runtime.getSetting("DISCORD_API_TOKEN") as string)
		: undefined;
	if (envToken) {
		return { token: envToken, source: "env" };
	}

	return { token: "", source: "none" };
}

/**
 * Resolves a complete Discord account configuration
 */
export function resolveDiscordAccount(
	runtime: IAgentRuntime,
	accountId?: string | null,
): ResolvedDiscordAccount {
	const normalizedAccountId = normalizeAccountId(accountId);
	const multiConfig = getMultiAccountConfig(runtime);

	const baseEnabled = multiConfig.enabled !== false;
	const merged = mergeDiscordAccountConfig(runtime, normalizedAccountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;

	const tokenResolution = resolveDiscordToken(runtime, {
		accountId: normalizedAccountId,
	});

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
 * Lists all enabled Discord accounts
 */
export function listEnabledDiscordAccounts(
	runtime: IAgentRuntime,
): ResolvedDiscordAccount[] {
	return listDiscordAccountIds(runtime)
		.map((accountId) => resolveDiscordAccount(runtime, accountId))
		.filter((account) => account.enabled && account.token);
}

/**
 * Checks if multi-account mode is enabled
 */
export function isMultiAccountEnabled(runtime: IAgentRuntime): boolean {
	const accounts = listEnabledDiscordAccounts(runtime);
	return accounts.length > 1;
}
