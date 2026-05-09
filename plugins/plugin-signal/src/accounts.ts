import type { IAgentRuntime } from "@elizaos/core";

/**
 * Default account identifier used when no specific account is configured
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * DM-specific configuration
 */
export interface SignalDmConfig {
  /** If false, ignore all incoming Signal DMs */
  enabled?: boolean;
  /** Direct message access policy */
  policy?: "open" | "disabled" | "allowlist" | "pairing";
  /** Allowlist for DM senders (phone numbers or UUIDs) */
  allowFrom?: Array<string | number>;
}

/**
 * Group-specific configuration
 */
export interface SignalGroupConfig {
  /** If false, ignore all group messages */
  enabled?: boolean;
  /** Group message access policy */
  policy?: "open" | "disabled" | "allowlist";
  /** Require bot mention to respond in groups */
  requireMention?: boolean;
  /** Allowlist for groups (IDs or names) */
  allowFrom?: Array<string | number>;
}

/**
 * Reaction notification mode
 */
export type SignalReactionNotificationMode = "off" | "own" | "all" | "allowlist";

/**
 * Configuration for a single Signal account
 */
export interface SignalAccountConfig {
  /** Optional display name for this account */
  name?: string;
  /** If false, do not start this Signal account */
  enabled?: boolean;
  /** Signal account phone number in E.164 format */
  account?: string;
  /** Signal CLI HTTP server URL */
  httpUrl?: string;
  /** Signal CLI auth/data directory */
  authDir?: string;
  /** Signal CLI HTTP server host */
  httpHost?: string;
  /** Signal CLI HTTP server port */
  httpPort?: number;
  /** Path to signal-cli binary */
  cliPath?: string;
  /** Auto-start signal-cli daemon if not running */
  autoStart?: boolean;
  /** Outbound text chunk size (chars) */
  textChunkLimit?: number;
  /** History limit for context */
  historyLimit?: number;
  /** Reaction notification mode */
  reactionNotifications?: SignalReactionNotificationMode;
  /** Reaction allowlist when mode is 'allowlist' */
  reactionAllowlist?: Array<string | number>;
  /** DM configuration */
  dm?: SignalDmConfig;
  /** Group configuration */
  group?: SignalGroupConfig;
  /** Whether to ignore group messages */
  shouldIgnoreGroupMessages?: boolean;
  /** Allowed groups */
  allowedGroups?: string[];
  /** Blocked numbers */
  blockedNumbers?: string[];
}

/**
 * Multi-account Signal configuration structure
 */
export interface SignalMultiAccountConfig {
  /** Default/base configuration applied to all accounts */
  enabled?: boolean;
  account?: string;
  httpUrl?: string;
  authDir?: string;
  /** Per-account configuration overrides */
  accounts?: Record<string, SignalAccountConfig>;
}

/**
 * Resolved Signal account with all configuration merged
 */
export interface ResolvedSignalAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  account?: string;
  baseUrl: string;
  configured: boolean;
  config: SignalAccountConfig;
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
 * Gets the multi-account configuration from runtime settings
 */
export function getMultiAccountConfig(runtime: IAgentRuntime): SignalMultiAccountConfig {
  const characterSignal = runtime.character?.settings?.signal as
    | SignalMultiAccountConfig
    | undefined;

  return {
    enabled: characterSignal?.enabled,
    account: characterSignal?.account,
    httpUrl: characterSignal?.httpUrl,
    authDir: characterSignal?.authDir,
    accounts: characterSignal?.accounts,
  };
}

/**
 * Lists all configured account IDs
 */
export function listSignalAccountIds(runtime: IAgentRuntime): string[] {
  const config = getMultiAccountConfig(runtime);
  const accounts = config.accounts;

  if (!accounts || typeof accounts !== "object") {
    return [DEFAULT_ACCOUNT_ID];
  }

  const ids = Object.keys(accounts).filter(Boolean);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return ids.toSorted((a: string, b: string) => a.localeCompare(b));
}

/**
 * Resolves the default account ID to use
 */
export function resolveDefaultSignalAccountId(runtime: IAgentRuntime): string {
  const ids = listSignalAccountIds(runtime);
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
): SignalAccountConfig | undefined {
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
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Merges base configuration with account-specific overrides
 */
function mergeSignalAccountConfig(runtime: IAgentRuntime, accountId: string): SignalAccountConfig {
  const multiConfig = getMultiAccountConfig(runtime);
  const { accounts: _ignored, ...baseConfig } = multiConfig;
  const accountConfig = getAccountConfig(runtime, accountId) ?? {};

  // Get environment/runtime settings for the base config
  const envAccount = runtime.getSetting("SIGNAL_ACCOUNT_NUMBER") as string | undefined;
  const envHttpUrl = runtime.getSetting("SIGNAL_HTTP_URL") as string | undefined;
  const envAuthDir = runtime.getSetting("SIGNAL_AUTH_DIR") as string | undefined;
  const envCliPath = runtime.getSetting("SIGNAL_CLI_PATH") as string | undefined;
  const envIgnoreGroups = runtime.getSetting("SIGNAL_SHOULD_IGNORE_GROUP_MESSAGES") as
    | string
    | undefined;

  const envConfig: SignalAccountConfig = {
    account: envAccount || undefined,
    httpUrl: envHttpUrl || undefined,
    authDir: envAuthDir || undefined,
    cliPath: envCliPath || undefined,
    shouldIgnoreGroupMessages: envIgnoreGroups?.toLowerCase() === "true",
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
 * Resolves the base URL for Signal CLI HTTP server
 */
function resolveBaseUrl(config: SignalAccountConfig): string {
  if (config.httpUrl?.trim()) {
    return config.httpUrl.trim().replace(/\/+$/, "");
  }
  const host = config.httpHost?.trim() || "127.0.0.1";
  const port = config.httpPort ?? 8080;
  return `http://${host}:${port}`;
}

/**
 * Resolves a complete Signal account configuration
 */
export function resolveSignalAccount(
  runtime: IAgentRuntime,
  accountId?: string | null
): ResolvedSignalAccount {
  const normalizedAccountId = normalizeAccountId(accountId);
  const multiConfig = getMultiAccountConfig(runtime);

  const baseEnabled = multiConfig.enabled !== false;
  const merged = mergeSignalAccountConfig(runtime, normalizedAccountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const baseUrl = resolveBaseUrl(merged);

  // Determine if this account is actually configured
  const configured = Boolean(
    merged.account?.trim() ||
      merged.httpUrl?.trim() ||
      merged.cliPath?.trim() ||
      merged.httpHost?.trim() ||
      typeof merged.httpPort === "number" ||
      typeof merged.autoStart === "boolean"
  );

  return {
    accountId: normalizedAccountId,
    enabled,
    name: merged.name?.trim() || undefined,
    account: merged.account?.trim(),
    baseUrl,
    configured,
    config: merged,
  };
}

/**
 * Lists all enabled Signal accounts
 */
export function listEnabledSignalAccounts(runtime: IAgentRuntime): ResolvedSignalAccount[] {
  return listSignalAccountIds(runtime)
    .map((accountId) => resolveSignalAccount(runtime, accountId))
    .filter((account) => account.enabled && account.configured);
}

/**
 * Checks if multi-account mode is enabled
 */
export function isMultiAccountEnabled(runtime: IAgentRuntime): boolean {
  const accounts = listEnabledSignalAccounts(runtime);
  return accounts.length > 1;
}
