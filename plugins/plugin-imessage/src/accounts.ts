import type { IAgentRuntime } from "@elizaos/core";

/**
 * Default account identifier used when no specific account is configured
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Group-specific configuration
 */
export interface IMessageGroupConfig {
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
 * Configuration for a single iMessage account
 */
export interface IMessageAccountConfig {
  /** Optional display name for this account */
  name?: string;
  /** If false, do not start this iMessage account */
  enabled?: boolean;
  /** Path to the iMessage CLI tool */
  cliPath?: string;
  /** Path to the iMessage database */
  dbPath?: string;
  /** iMessage service type (iMessage or SMS) */
  service?: "iMessage" | "SMS";
  /** Phone number region code */
  region?: string;
  /** Allowlist for DM senders */
  allowFrom?: Array<string | number>;
  /** Allowlist for groups */
  groupAllowFrom?: Array<string | number>;
  /** DM access policy */
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  /** Group message access policy */
  groupPolicy?: "open" | "allowlist" | "disabled";
  /** Whether to include attachments */
  includeAttachments?: boolean;
  /** Max media size in MB */
  mediaMaxMb?: number;
  /** Text chunk limit for messages */
  textChunkLimit?: number;
  /** Group-specific configurations */
  groups?: Record<string, IMessageGroupConfig>;
}

/**
 * Multi-account iMessage configuration structure
 */
export interface IMessageMultiAccountConfig {
  /** Default/base configuration applied to all accounts */
  enabled?: boolean;
  cliPath?: string;
  dbPath?: string;
  service?: "iMessage" | "SMS";
  region?: string;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  includeAttachments?: boolean;
  mediaMaxMb?: number;
  textChunkLimit?: number;
  /** Per-account configuration overrides */
  accounts?: Record<string, IMessageAccountConfig>;
  /** Group configurations at base level */
  groups?: Record<string, IMessageGroupConfig>;
}

/**
 * Resolved iMessage account with all configuration merged
 */
export interface ResolvedIMessageAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  cliPath: string;
  dbPath?: string;
  configured: boolean;
  config: IMessageAccountConfig;
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
export function getMultiAccountConfig(runtime: IAgentRuntime): IMessageMultiAccountConfig {
  const characterIMessage = runtime.character?.settings?.imessage as
    | IMessageMultiAccountConfig
    | undefined;

  return {
    enabled: characterIMessage?.enabled,
    cliPath: characterIMessage?.cliPath,
    dbPath: characterIMessage?.dbPath,
    service: characterIMessage?.service,
    region: characterIMessage?.region,
    dmPolicy: characterIMessage?.dmPolicy,
    groupPolicy: characterIMessage?.groupPolicy,
    includeAttachments: characterIMessage?.includeAttachments,
    mediaMaxMb: characterIMessage?.mediaMaxMb,
    textChunkLimit: characterIMessage?.textChunkLimit,
    accounts: characterIMessage?.accounts,
    groups: characterIMessage?.groups,
  };
}

/**
 * Lists all configured account IDs
 */
export function listIMessageAccountIds(runtime: IAgentRuntime): string[] {
  const config = getMultiAccountConfig(runtime);
  const accounts = config.accounts;

  if (!accounts || typeof accounts !== "object") {
    return [DEFAULT_ACCOUNT_ID];
  }

  const ids = Object.keys(accounts).filter(Boolean);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return ids.slice().sort((a: string, b: string) => a.localeCompare(b));
}

/**
 * Resolves the default account ID to use
 */
export function resolveDefaultIMessageAccountId(runtime: IAgentRuntime): string {
  const ids = listIMessageAccountIds(runtime);
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
): IMessageAccountConfig | undefined {
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
function mergeIMessageAccountConfig(
  runtime: IAgentRuntime,
  accountId: string
): IMessageAccountConfig {
  const multiConfig = getMultiAccountConfig(runtime);
  const { accounts: _ignored, ...baseConfig } = multiConfig;
  const accountConfig = getAccountConfig(runtime, accountId) ?? {};

  // Get environment/runtime settings for the base config
  const envCliPath = runtime.getSetting("IMESSAGE_CLI_PATH") as string | undefined;
  const envDbPath = runtime.getSetting("IMESSAGE_DB_PATH") as string | undefined;
  const envDmPolicy = runtime.getSetting("IMESSAGE_DM_POLICY") as string | undefined;
  const envGroupPolicy = runtime.getSetting("IMESSAGE_GROUP_POLICY") as string | undefined;

  const envConfig: IMessageAccountConfig = {
    cliPath: envCliPath || undefined,
    dbPath: envDbPath || undefined,
    dmPolicy: envDmPolicy as IMessageAccountConfig["dmPolicy"] | undefined,
    groupPolicy: envGroupPolicy as IMessageAccountConfig["groupPolicy"] | undefined,
  };

  // Merge order: env defaults < base config < account config
  return {
    ...envConfig,
    ...baseConfig,
    ...accountConfig,
  };
}

/**
 * Resolves a complete iMessage account configuration
 */
export function resolveIMessageAccount(
  runtime: IAgentRuntime,
  accountId?: string | null
): ResolvedIMessageAccount {
  const normalizedAccountId = normalizeAccountId(accountId);
  const multiConfig = getMultiAccountConfig(runtime);

  const baseEnabled = multiConfig.enabled !== false;
  const merged = mergeIMessageAccountConfig(runtime, normalizedAccountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const cliPath = merged.cliPath?.trim() || "imsg";

  // Determine if this account is actually configured
  const configured = Boolean(
    merged.cliPath?.trim() ||
      merged.dbPath?.trim() ||
      merged.service ||
      merged.region?.trim() ||
      (merged.allowFrom && merged.allowFrom.length > 0) ||
      (merged.groupAllowFrom && merged.groupAllowFrom.length > 0) ||
      merged.dmPolicy ||
      merged.groupPolicy ||
      typeof merged.includeAttachments === "boolean" ||
      typeof merged.mediaMaxMb === "number" ||
      typeof merged.textChunkLimit === "number" ||
      (merged.groups && Object.keys(merged.groups).length > 0)
  );

  return {
    accountId: normalizedAccountId,
    enabled,
    name: merged.name?.trim() || undefined,
    cliPath,
    dbPath: merged.dbPath?.trim() || undefined,
    configured,
    config: merged,
  };
}

/**
 * Lists all enabled iMessage accounts
 */
export function listEnabledIMessageAccounts(runtime: IAgentRuntime): ResolvedIMessageAccount[] {
  return listIMessageAccountIds(runtime)
    .map((accountId) => resolveIMessageAccount(runtime, accountId))
    .filter((account) => account.enabled);
}

/**
 * Checks if multi-account mode is enabled
 */
export function isMultiAccountEnabled(runtime: IAgentRuntime): boolean {
  const accounts = listEnabledIMessageAccounts(runtime);
  return accounts.length > 1;
}

/**
 * Resolves group configuration for a specific group
 */
export function resolveIMessageGroupConfig(
  runtime: IAgentRuntime,
  accountId: string,
  groupId: string
): IMessageGroupConfig | undefined {
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
export function isIMessageUserAllowed(params: {
  identifier: string;
  accountConfig: IMessageAccountConfig;
  isGroup: boolean;
  groupId?: string;
  groupConfig?: IMessageGroupConfig;
}): boolean {
  const { identifier, accountConfig, isGroup, groupConfig } = params;

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
      return groupConfig.allowFrom.some((allowed) => String(allowed) === identifier);
    }

    // Check account-level group allowlist
    if (accountConfig.groupAllowFrom?.length) {
      return accountConfig.groupAllowFrom.some((allowed) => String(allowed) === identifier);
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
    return accountConfig.allowFrom.some((allowed) => String(allowed) === identifier);
  }

  return false;
}

/**
 * Checks if mention is required in a group
 */
export function isIMessageMentionRequired(params: {
  accountConfig: IMessageAccountConfig;
  groupConfig?: IMessageGroupConfig;
}): boolean {
  const { groupConfig } = params;
  return groupConfig?.requireMention ?? false;
}
