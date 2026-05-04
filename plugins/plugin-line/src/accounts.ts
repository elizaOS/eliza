import type { IAgentRuntime } from "@elizaos/core";

/**
 * Default account identifier used when no specific account is configured
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Token source indicator
 */
export type LineTokenSource = "config" | "env" | "character" | "none";

/**
 * Group-specific configuration
 */
export interface LineGroupConfig {
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
 * Configuration for a single LINE account
 */
export interface LineAccountConfig {
  /** Optional display name for this account */
  name?: string;
  /** If false, do not start this LINE account */
  enabled?: boolean;
  /** Channel access token */
  channelAccessToken?: string;
  /** Channel secret */
  channelSecret?: string;
  /** Path to file containing channel access token */
  tokenFile?: string;
  /** Path to file containing channel secret */
  secretFile?: string;
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
  /** Custom webhook path */
  webhookPath?: string;
  /** Group-specific configurations */
  groups?: Record<string, LineGroupConfig>;
}

/**
 * Multi-account LINE configuration structure
 */
export interface LineMultiAccountConfig {
  /** Default/base configuration applied to all accounts */
  enabled?: boolean;
  channelAccessToken?: string;
  channelSecret?: string;
  tokenFile?: string;
  secretFile?: string;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  mediaMaxMb?: number;
  webhookPath?: string;
  /** Per-account configuration overrides */
  accounts?: Record<string, LineAccountConfig>;
  /** Group configurations at base level */
  groups?: Record<string, LineGroupConfig>;
}

/**
 * Token resolution result
 */
export interface LineTokenResolution {
  token: string;
  source: LineTokenSource;
}

/**
 * Resolved LINE account with all configuration merged
 */
export interface ResolvedLineAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  channelAccessToken: string;
  channelSecret: string;
  tokenSource: LineTokenSource;
  configured: boolean;
  config: LineAccountConfig;
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
export function getMultiAccountConfig(runtime: IAgentRuntime): LineMultiAccountConfig {
  const characterLine = runtime.character?.settings?.line as LineMultiAccountConfig | undefined;

  return {
    enabled: characterLine?.enabled,
    channelAccessToken: characterLine?.channelAccessToken,
    channelSecret: characterLine?.channelSecret,
    tokenFile: characterLine?.tokenFile,
    secretFile: characterLine?.secretFile,
    dmPolicy: characterLine?.dmPolicy,
    groupPolicy: characterLine?.groupPolicy,
    mediaMaxMb: characterLine?.mediaMaxMb,
    webhookPath: characterLine?.webhookPath,
    accounts: characterLine?.accounts,
    groups: characterLine?.groups,
  };
}

/**
 * Lists all configured account IDs
 */
export function listLineAccountIds(runtime: IAgentRuntime): string[] {
  const config = getMultiAccountConfig(runtime);
  const accounts = config.accounts;
  const ids = new Set<string>();

  // Add default account if configured at base level
  const envToken = runtime.getSetting("LINE_CHANNEL_ACCESS_TOKEN") as string | undefined;
  if (config.channelAccessToken?.trim() || config.tokenFile || envToken?.trim()) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  // Add named accounts
  if (accounts && typeof accounts === "object") {
    for (const id of Object.keys(accounts)) {
      if (id) {
        ids.add(id);
      }
    }
  }

  const result = Array.from(ids);
  if (result.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return result.slice().sort((a: string, b: string) => a.localeCompare(b));
}

/**
 * Resolves the default account ID to use
 */
export function resolveDefaultLineAccountId(runtime: IAgentRuntime): string {
  const ids = listLineAccountIds(runtime);
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
): LineAccountConfig | undefined {
  const config = getMultiAccountConfig(runtime);
  const accounts = config.accounts;

  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }

  return accounts[accountId];
}

/**
 * Resolves the channel access token for a LINE account
 */
export function resolveLineToken(runtime: IAgentRuntime, accountId: string): LineTokenResolution {
  const multiConfig = getMultiAccountConfig(runtime);
  const accountConfig = getAccountConfig(runtime, accountId);

  // Check account-level config first
  if (accountConfig?.channelAccessToken?.trim()) {
    return { token: accountConfig.channelAccessToken.trim(), source: "config" };
  }

  // For default account, check base config
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (multiConfig.channelAccessToken?.trim()) {
      return { token: multiConfig.channelAccessToken.trim(), source: "config" };
    }

    // Check environment/runtime settings
    const envToken = runtime.getSetting("LINE_CHANNEL_ACCESS_TOKEN") as string | undefined;
    if (envToken?.trim()) {
      return { token: envToken.trim(), source: "env" };
    }
  }

  return { token: "", source: "none" };
}

/**
 * Resolves the channel secret for a LINE account
 */
export function resolveLineSecret(runtime: IAgentRuntime, accountId: string): string {
  const multiConfig = getMultiAccountConfig(runtime);
  const accountConfig = getAccountConfig(runtime, accountId);

  // Check account-level config first
  if (accountConfig?.channelSecret?.trim()) {
    return accountConfig.channelSecret.trim();
  }

  // For default account, check base config and env
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (multiConfig.channelSecret?.trim()) {
      return multiConfig.channelSecret.trim();
    }

    const envSecret = runtime.getSetting("LINE_CHANNEL_SECRET") as string | undefined;
    if (envSecret?.trim()) {
      return envSecret.trim();
    }
  }

  return "";
}

/**
 * Merges base configuration with account-specific overrides
 */
/**
 * Removes undefined values from an object to prevent them from overwriting during spread
 */
function filterDefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function mergeLineAccountConfig(runtime: IAgentRuntime, accountId: string): LineAccountConfig {
  const multiConfig = getMultiAccountConfig(runtime);
  const { accounts: _ignored, ...baseConfig } = multiConfig;
  const accountConfig = getAccountConfig(runtime, accountId) ?? {};

  // Get environment/runtime settings for the base config
  const envDmPolicy = runtime.getSetting("LINE_DM_POLICY") as string | undefined;
  const envGroupPolicy = runtime.getSetting("LINE_GROUP_POLICY") as string | undefined;

  const envConfig: LineAccountConfig = {
    dmPolicy: envDmPolicy as LineAccountConfig["dmPolicy"] | undefined,
    groupPolicy: envGroupPolicy as LineAccountConfig["groupPolicy"] | undefined,
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
 * Resolves a complete LINE account configuration
 */
export function resolveLineAccount(
  runtime: IAgentRuntime,
  accountId?: string | null
): ResolvedLineAccount {
  const normalizedAccountId = normalizeAccountId(accountId);
  const multiConfig = getMultiAccountConfig(runtime);

  const baseEnabled = multiConfig.enabled !== false;
  const merged = mergeLineAccountConfig(runtime, normalizedAccountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const { token, source: tokenSource } = resolveLineToken(runtime, normalizedAccountId);
  const secret = resolveLineSecret(runtime, normalizedAccountId);

  // Determine if this account is actually configured
  const configured = Boolean(token || secret);

  return {
    accountId: normalizedAccountId,
    enabled,
    name: merged.name?.trim() || undefined,
    channelAccessToken: token,
    channelSecret: secret,
    tokenSource,
    configured,
    config: merged,
  };
}

/**
 * Lists all enabled LINE accounts
 */
export function listEnabledLineAccounts(runtime: IAgentRuntime): ResolvedLineAccount[] {
  return listLineAccountIds(runtime)
    .map((accountId) => resolveLineAccount(runtime, accountId))
    .filter((account) => account.enabled && account.configured);
}

/**
 * Checks if multi-account mode is enabled
 */
export function isMultiAccountEnabled(runtime: IAgentRuntime): boolean {
  const accounts = listEnabledLineAccounts(runtime);
  return accounts.length > 1;
}

/**
 * Resolves group configuration for a specific group
 */
export function resolveLineGroupConfig(
  runtime: IAgentRuntime,
  accountId: string,
  groupId: string
): LineGroupConfig | undefined {
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
export function isLineUserAllowed(params: {
  userId: string;
  accountConfig: LineAccountConfig;
  isGroup: boolean;
  groupId?: string;
  groupConfig?: LineGroupConfig;
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
      return groupConfig.allowFrom.some((allowed) => String(allowed) === userId);
    }

    // Check account-level group allowlist
    if (accountConfig.groupAllowFrom?.length) {
      return accountConfig.groupAllowFrom.some((allowed) => String(allowed) === userId);
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
    return accountConfig.allowFrom.some((allowed) => String(allowed) === userId);
  }

  return false;
}

/**
 * Checks if mention is required in a group
 */
export function isLineMentionRequired(params: {
  accountConfig: LineAccountConfig;
  groupConfig?: LineGroupConfig;
}): boolean {
  const { groupConfig } = params;
  return groupConfig?.requireMention ?? false;
}
