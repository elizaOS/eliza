import type { IAgentRuntime } from "@elizaos/core";

/**
 * Default account identifier used when no specific account is configured
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Token source indicator
 */
export type FeishuTokenSource = "config" | "env" | "character" | "none";

/**
 * Group-specific configuration
 */
export interface FeishuGroupConfig {
	/** If false, ignore messages from this group */
	enabled?: boolean;
	/** Allowlist for users in this group */
	allowFrom?: Array<string | number>;
	/** Require bot mention to respond */
	requireMention?: boolean;
	/** Custom system prompt for this group */
	systemPrompt?: string;
	/** Skills enabled for this group */
	skills?: string[];
}

/**
 * Configuration for a single Feishu account
 */
export interface FeishuAccountConfig {
	/** Optional display name for this account */
	name?: string;
	/** Bot display name */
	botName?: string;
	/** If false, do not start this Feishu account */
	enabled?: boolean;
	/** Feishu App ID */
	appId?: string;
	/** Feishu App Secret */
	appSecret?: string;
	/** Path to file containing app secret */
	appSecretFile?: string;
	/** Encrypt key for event callback */
	encryptKey?: string;
	/** Verification token for event callback */
	verificationToken?: string;
	/** Base API URL (for self-hosted Feishu) */
	apiUrl?: string;
	/** Allowlist for DM senders */
	allowFrom?: Array<string | number>;
	/** Allowlist for groups */
	groupAllowFrom?: Array<string | number>;
	/** DM access policy */
	dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
	/** Group message access policy */
	groupPolicy?: "open" | "allowlist" | "disabled";
	/** Max media size in MB */
	mediaMaxMb?: number;
	/** Text chunk limit for messages */
	textChunkLimit?: number;
	/** Webhook path for event callbacks */
	webhookPath?: string;
	/** Group-specific configurations */
	groups?: Record<string, FeishuGroupConfig>;
}

/**
 * Multi-account Feishu configuration structure
 */
export interface FeishuMultiAccountConfig {
	/** Default/base configuration applied to all accounts */
	enabled?: boolean;
	appId?: string;
	appSecret?: string;
	appSecretFile?: string;
	encryptKey?: string;
	verificationToken?: string;
	apiUrl?: string;
	dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
	groupPolicy?: "open" | "allowlist" | "disabled";
	mediaMaxMb?: number;
	textChunkLimit?: number;
	webhookPath?: string;
	/** Per-account configuration overrides */
	accounts?: Record<string, FeishuAccountConfig>;
	/** Group configurations at base level */
	groups?: Record<string, FeishuGroupConfig>;
}

/**
 * Resolved Feishu account with all configuration merged
 */
export interface ResolvedFeishuAccount {
	accountId: string;
	enabled: boolean;
	name?: string;
	appId: string;
	appSecret: string;
	tokenSource: FeishuTokenSource;
	configured: boolean;
	config: FeishuAccountConfig;
}

/**
 * Normalizes an account ID, returning the default if not provided
 */
export function normalizeAccountId(accountId?: string | null): string {
	if (!accountId || typeof accountId !== "string") {
		return DEFAULT_ACCOUNT_ID;
	}
	const trimmed = accountId.trim().toLowerCase();
	if (!trimmed || trimmed === "default") {
		return DEFAULT_ACCOUNT_ID;
	}
	return trimmed;
}

/**
 * Gets the multi-account configuration from runtime settings
 */
export function getMultiAccountConfig(
	runtime: IAgentRuntime,
): FeishuMultiAccountConfig {
	const characterFeishu = runtime.character?.settings?.feishu as
		| FeishuMultiAccountConfig
		| undefined;

	return {
		enabled: characterFeishu?.enabled,
		appId: characterFeishu?.appId,
		appSecret: characterFeishu?.appSecret,
		appSecretFile: characterFeishu?.appSecretFile,
		encryptKey: characterFeishu?.encryptKey,
		verificationToken: characterFeishu?.verificationToken,
		apiUrl: characterFeishu?.apiUrl,
		dmPolicy: characterFeishu?.dmPolicy,
		groupPolicy: characterFeishu?.groupPolicy,
		mediaMaxMb: characterFeishu?.mediaMaxMb,
		textChunkLimit: characterFeishu?.textChunkLimit,
		webhookPath: characterFeishu?.webhookPath,
		accounts: characterFeishu?.accounts,
		groups: characterFeishu?.groups,
	};
}

/**
 * Lists all configured account IDs
 */
export function listFeishuAccountIds(runtime: IAgentRuntime): string[] {
	const config = getMultiAccountConfig(runtime);
	const accounts = config.accounts;
	const ids = new Set<string>();

	// Check if default account is configured
	const envAppId = runtime.getSetting("FEISHU_APP_ID") as string | undefined;
	const envAppSecret = runtime.getSetting("FEISHU_APP_SECRET") as
		| string
		| undefined;

	const baseConfigured = Boolean(
		config.appId?.trim() && (config.appSecret?.trim() || config.appSecretFile),
	);
	const envConfigured = Boolean(envAppId?.trim() && envAppSecret?.trim());

	if (baseConfigured || envConfigured) {
		ids.add(DEFAULT_ACCOUNT_ID);
	}

	// Add named accounts
	if (accounts && typeof accounts === "object") {
		for (const id of Object.keys(accounts)) {
			if (id) {
				ids.add(normalizeAccountId(id));
			}
		}
	}

	const result = Array.from(ids);
	if (result.length === 0) {
		return [DEFAULT_ACCOUNT_ID];
	}

	return result.toSorted((a, b) => a.localeCompare(b));
}

/**
 * Resolves the default account ID to use
 */
export function resolveDefaultFeishuAccountId(runtime: IAgentRuntime): string {
	const ids = listFeishuAccountIds(runtime);
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
): FeishuAccountConfig | undefined {
	const config = getMultiAccountConfig(runtime);
	const accounts = config.accounts;

	if (!accounts || typeof accounts !== "object") {
		return undefined;
	}

	// Try direct match first
	const direct = accounts[accountId];
	if (direct) {
		return direct;
	}

	// Try normalized match
	const normalized = normalizeAccountId(accountId);
	const matchKey = Object.keys(accounts).find(
		(key) => normalizeAccountId(key) === normalized,
	);
	return matchKey ? accounts[matchKey] : undefined;
}

/**
 * Merges base configuration with account-specific overrides
 */
function mergeFeishuAccountConfig(
	runtime: IAgentRuntime,
	accountId: string,
): FeishuAccountConfig {
	const multiConfig = getMultiAccountConfig(runtime);
	const { accounts: _ignored, ...baseConfig } = multiConfig;
	const accountConfig = getAccountConfig(runtime, accountId) ?? {};

	// Get environment/runtime settings for the base config
	const envAppId = runtime.getSetting("FEISHU_APP_ID") as string | undefined;
	const envAppSecret = runtime.getSetting("FEISHU_APP_SECRET") as
		| string
		| undefined;
	const envEncryptKey = runtime.getSetting("FEISHU_ENCRYPT_KEY") as
		| string
		| undefined;
	const envVerificationToken = runtime.getSetting(
		"FEISHU_VERIFICATION_TOKEN",
	) as string | undefined;
	const envDmPolicy = runtime.getSetting("FEISHU_DM_POLICY") as
		| string
		| undefined;
	const envGroupPolicy = runtime.getSetting("FEISHU_GROUP_POLICY") as
		| string
		| undefined;

	const envConfig: FeishuAccountConfig = {
		appId: envAppId || undefined,
		appSecret: envAppSecret || undefined,
		encryptKey: envEncryptKey || undefined,
		verificationToken: envVerificationToken || undefined,
		dmPolicy: envDmPolicy as FeishuAccountConfig["dmPolicy"] | undefined,
		groupPolicy: envGroupPolicy as
			| FeishuAccountConfig["groupPolicy"]
			| undefined,
	};

	// Merge order: env defaults < base config < account config
	return {
		...envConfig,
		...baseConfig,
		...accountConfig,
	};
}

/**
 * Resolves a complete Feishu account configuration
 */
export function resolveFeishuAccount(
	runtime: IAgentRuntime,
	accountId?: string | null,
): ResolvedFeishuAccount {
	const normalizedAccountId = normalizeAccountId(accountId);
	const multiConfig = getMultiAccountConfig(runtime);

	const baseEnabled = multiConfig.enabled !== false;
	const merged = mergeFeishuAccountConfig(runtime, normalizedAccountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;

	const appId = merged.appId?.trim() || "";
	const appSecret = merged.appSecret?.trim() || "";

	// Determine token source
	let tokenSource: FeishuTokenSource = "none";
	if (merged.appSecret?.trim()) {
		tokenSource = "config";
	} else {
		const envAppSecret = runtime.getSetting("FEISHU_APP_SECRET") as
			| string
			| undefined;
		if (envAppSecret?.trim()) {
			tokenSource = "env";
		}
	}

	if (!appId || !appSecret) {
		tokenSource = "none";
	}

	// Determine if this account is actually configured
	const configured = Boolean(appId && appSecret);

	const name = merged.name?.trim() || merged.botName?.trim() || undefined;

	return {
		accountId: normalizedAccountId,
		enabled,
		name,
		appId,
		appSecret,
		tokenSource,
		configured,
		config: merged,
	};
}

/**
 * Lists all enabled Feishu accounts
 */
export function listEnabledFeishuAccounts(
	runtime: IAgentRuntime,
): ResolvedFeishuAccount[] {
	return listFeishuAccountIds(runtime)
		.map((accountId) => resolveFeishuAccount(runtime, accountId))
		.filter((account) => account.enabled && account.configured);
}

/**
 * Checks if multi-account mode is enabled
 */
export function isMultiAccountEnabled(runtime: IAgentRuntime): boolean {
	const accounts = listEnabledFeishuAccounts(runtime);
	return accounts.length > 1;
}

/**
 * Resolves group configuration for a specific group
 */
export function resolveFeishuGroupConfig(
	runtime: IAgentRuntime,
	accountId: string,
	groupId: string,
): FeishuGroupConfig | undefined {
	const multiConfig = getMultiAccountConfig(runtime);
	const accountConfig = getAccountConfig(runtime, accountId);

	// Check account-level groups first
	const accountGroup = accountConfig?.groups?.[groupId];
	if (accountGroup) {
		return accountGroup;
	}

	// Fall back to base-level groups
	return multiConfig.groups?.[groupId];
}

/**
 * Checks if a user is allowed based on policy and allowlist
 */
export function isFeishuUserAllowed(params: {
	userId: string;
	accountConfig: FeishuAccountConfig;
	isGroup: boolean;
	groupId?: string;
	groupConfig?: FeishuGroupConfig;
}): boolean {
	const { userId, accountConfig, isGroup, groupConfig } = params;

	if (isGroup) {
		const policy = accountConfig.groupPolicy ?? "allowlist";
		if (policy === "disabled") {
			return false;
		}

		if (policy === "open") {
			return true;
		}

		// Check group-specific allowlist first
		if (groupConfig?.allowFrom?.length) {
			return groupConfig.allowFrom.some(
				(allowed) => String(allowed) === userId,
			);
		}

		// Check account-level group allowlist
		if (accountConfig.groupAllowFrom?.length) {
			return accountConfig.groupAllowFrom.some(
				(allowed) => String(allowed) === userId,
			);
		}

		return policy !== "allowlist";
	}

	// DM handling
	const policy = accountConfig.dmPolicy ?? "pairing";
	if (policy === "disabled") {
		return false;
	}

	if (policy === "open") {
		return true;
	}

	if (policy === "pairing") {
		return true;
	}

	// Allowlist policy
	if (accountConfig.allowFrom?.length) {
		return accountConfig.allowFrom.some(
			(allowed) => String(allowed) === userId,
		);
	}

	return false;
}

/**
 * Checks if mention is required in a group
 */
export function isFeishuMentionRequired(params: {
	accountConfig: FeishuAccountConfig;
	groupConfig?: FeishuGroupConfig;
}): boolean {
	const { groupConfig } = params;
	return groupConfig?.requireMention ?? false;
}
