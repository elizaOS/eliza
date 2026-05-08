/**
 * Multi-account scaffolding for the BlueBubbles connector.
 *
 * Each "account" represents a distinct BlueBubbles server URL + password pair.
 * In practice there is usually one BlueBubbles server per macOS host, but the
 * accountId surface still applies for users running multiple BlueBubbles
 * servers (e.g. a personal mac + a separate macOS box for a side identity).
 *
 * Source of truth is `character.settings.bluebubbles` plus env-var fallbacks
 * (BLUEBUBBLES_SERVER_URL, BLUEBUBBLES_PASSWORD, BLUEBUBBLES_DM_POLICY, ...).
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
	BlueBubblesConfig,
	DmPolicy,
	GroupPolicy,
} from "./types";

/**
 * Default account identifier used when no specific account is configured.
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Configuration for a single BlueBubbles account.
 */
export interface BlueBubblesAccountConfig {
	/** Optional display name for this account */
	name?: string;
	/** If false, do not start this BlueBubbles account */
	enabled?: boolean;
	/** BlueBubbles server URL */
	serverUrl?: string;
	/** BlueBubbles server password */
	password?: string;
	/** Webhook path */
	webhookPath?: string;
	/** Auto-start command */
	autoStartCommand?: string;
	/** Auto-start args */
	autoStartArgs?: string[];
	/** Auto-start cwd */
	autoStartCwd?: string;
	/** Auto-start wait ms */
	autoStartWaitMs?: number;
	/** DM access policy */
	dmPolicy?: DmPolicy;
	/** Group message access policy */
	groupPolicy?: GroupPolicy;
	/** Allowlist for DM senders */
	allowFrom?: string[];
	/** Allowlist for groups */
	groupAllowFrom?: string[];
	/** Whether to send read receipts */
	sendReadReceipts?: boolean;
}

/**
 * Multi-account BlueBubbles configuration structure.
 */
export interface BlueBubblesMultiAccountConfig {
	enabled?: boolean;
	serverUrl?: string;
	password?: string;
	webhookPath?: string;
	dmPolicy?: DmPolicy;
	groupPolicy?: GroupPolicy;
	/** Per-account configuration overrides */
	accounts?: Record<string, BlueBubblesAccountConfig>;
}

/**
 * Resolved BlueBubbles account with all configuration merged.
 */
export interface ResolvedBlueBubblesAccount {
	accountId: string;
	enabled: boolean;
	name?: string;
	serverUrl: string;
	configured: boolean;
	config: BlueBubblesConfig | null;
}

/**
 * Normalizes an account ID, returning the default if not provided.
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
 * Gets the multi-account configuration from runtime settings.
 */
export function getMultiAccountConfig(
	runtime: IAgentRuntime,
): BlueBubblesMultiAccountConfig {
	const characterBlueBubbles = runtime.character?.settings?.bluebubbles as
		| BlueBubblesMultiAccountConfig
		| undefined;

	return {
		enabled: characterBlueBubbles?.enabled,
		serverUrl: characterBlueBubbles?.serverUrl,
		password: characterBlueBubbles?.password,
		webhookPath: characterBlueBubbles?.webhookPath,
		dmPolicy: characterBlueBubbles?.dmPolicy,
		groupPolicy: characterBlueBubbles?.groupPolicy,
		accounts: characterBlueBubbles?.accounts,
	};
}

/**
 * Lists all configured account IDs.
 */
export function listBlueBubblesAccountIds(runtime: IAgentRuntime): string[] {
	const config = getMultiAccountConfig(runtime);
	const accounts = config.accounts;
	const ids = new Set<string>();

	const envServerUrl = runtime.getSetting("BLUEBUBBLES_SERVER_URL") as
		| string
		| undefined;
	const envPassword = runtime.getSetting("BLUEBUBBLES_PASSWORD") as
		| string
		| undefined;

	const baseConfigured = Boolean(
		config.serverUrl?.trim() && config.password?.trim(),
	);
	const envConfigured = Boolean(envServerUrl?.trim() && envPassword?.trim());

	if (baseConfigured || envConfigured) {
		ids.add(DEFAULT_ACCOUNT_ID);
	}

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
	return result.slice().sort((a, b) => a.localeCompare(b));
}

/**
 * Gets the account-specific configuration.
 */
function getAccountConfig(
	runtime: IAgentRuntime,
	accountId: string,
): BlueBubblesAccountConfig | undefined {
	const config = getMultiAccountConfig(runtime);
	const accounts = config.accounts;
	if (!accounts || typeof accounts !== "object") {
		return undefined;
	}
	const direct = accounts[accountId];
	if (direct) {
		return direct;
	}
	const normalized = normalizeAccountId(accountId);
	const matchKey = Object.keys(accounts).find(
		(key) => normalizeAccountId(key) === normalized,
	);
	return matchKey ? accounts[matchKey] : undefined;
}

/**
 * Resolves a complete BlueBubbles account configuration as a
 * `BlueBubblesConfig` (the shape consumed by the existing service code).
 *
 * Returns `null` if neither account-specific nor base config / env defaults
 * provide a complete (`serverUrl`, `password`) pair.
 */
export function resolveBlueBubblesAccount(
	runtime: IAgentRuntime,
	accountId?: string | null,
): ResolvedBlueBubblesAccount {
	const normalizedAccountId = normalizeAccountId(accountId);
	const multiConfig = getMultiAccountConfig(runtime);
	const accountConfig = getAccountConfig(runtime, normalizedAccountId) ?? {};

	const baseEnabled = multiConfig.enabled !== false;
	const accountEnabled = accountConfig.enabled !== false;
	const enabled = baseEnabled && accountEnabled;

	const envServerUrl = runtime.getSetting("BLUEBUBBLES_SERVER_URL") as
		| string
		| undefined;
	const envPassword = runtime.getSetting("BLUEBUBBLES_PASSWORD") as
		| string
		| undefined;

	const serverUrl =
		accountConfig.serverUrl?.trim() ||
		multiConfig.serverUrl?.trim() ||
		envServerUrl?.trim() ||
		"";
	const password =
		accountConfig.password?.trim() ||
		multiConfig.password?.trim() ||
		envPassword?.trim() ||
		"";

	const configured = Boolean(serverUrl && password);

	const resolvedConfig: BlueBubblesConfig | null = configured
		? {
				serverUrl,
				password,
				webhookPath:
					accountConfig.webhookPath ?? multiConfig.webhookPath ?? undefined,
				autoStartCommand: accountConfig.autoStartCommand,
				autoStartArgs: accountConfig.autoStartArgs,
				autoStartCwd: accountConfig.autoStartCwd,
				autoStartWaitMs: accountConfig.autoStartWaitMs,
				dmPolicy: accountConfig.dmPolicy ?? multiConfig.dmPolicy ?? "pairing",
				groupPolicy:
					accountConfig.groupPolicy ?? multiConfig.groupPolicy ?? "allowlist",
				allowFrom: accountConfig.allowFrom ?? [],
				groupAllowFrom: accountConfig.groupAllowFrom ?? [],
				sendReadReceipts: accountConfig.sendReadReceipts ?? true,
				enabled,
			}
		: null;

	return {
		accountId: normalizedAccountId,
		enabled,
		name: accountConfig.name?.trim() || undefined,
		serverUrl,
		configured,
		config: resolvedConfig,
	};
}

/**
 * Resolves the default account ID to use.
 */
export function resolveDefaultBlueBubblesAccountId(
	runtime: IAgentRuntime,
): string {
	const ids = listBlueBubblesAccountIds(runtime);
	if (ids.includes(DEFAULT_ACCOUNT_ID)) {
		return DEFAULT_ACCOUNT_ID;
	}
	return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

/**
 * Lists all enabled BlueBubbles accounts.
 */
export function listEnabledBlueBubblesAccounts(
	runtime: IAgentRuntime,
): ResolvedBlueBubblesAccount[] {
	return listBlueBubblesAccountIds(runtime)
		.map((accountId) => resolveBlueBubblesAccount(runtime, accountId))
		.filter((account) => account.enabled && account.configured);
}

/**
 * Checks if multi-account mode is enabled.
 */
export function isMultiAccountEnabled(runtime: IAgentRuntime): boolean {
	return listEnabledBlueBubblesAccounts(runtime).length > 1;
}
