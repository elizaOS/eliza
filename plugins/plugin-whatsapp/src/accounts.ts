import type { IAgentRuntime } from "@elizaos/core";
import { checkPairingAllowed, isInAllowlist, type PairingCheckResult } from "@elizaos/core";

/**
 * Default account identifier used when no specific account is configured
 */
export const DEFAULT_ACCOUNT_ID = "default";

/**
 * Token source indicator
 */
export type WhatsAppTokenSource = "config" | "env" | "character" | "none";

/**
 * Group-specific runtime configuration (for account resolution)
 */
export interface WhatsAppGroupRuntimeConfig {
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
 * Configuration for a single WhatsApp account (runtime resolution)
 */
export interface WhatsAppAccountRuntimeConfig {
  /** Optional display name for this account */
  name?: string;
  /** If false, do not start this WhatsApp account */
  enabled?: boolean;
  /** WhatsApp Cloud API access token */
  accessToken?: string;
  /** Phone number ID from WhatsApp Business */
  phoneNumberId?: string;
  /** Business account ID */
  businessAccountId?: string;
  /** Webhook verification token */
  webhookVerifyToken?: string;
  /** API version to use */
  apiVersion?: string;
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
  /** Group-specific configurations */
  groups?: Record<string, WhatsAppGroupRuntimeConfig>;
}

/**
 * Multi-account WhatsApp configuration structure
 */
export interface WhatsAppMultiAccountConfig {
  /** Default/base configuration applied to all accounts */
  enabled?: boolean;
  accessToken?: string;
  phoneNumberId?: string;
  businessAccountId?: string;
  webhookVerifyToken?: string;
  apiVersion?: string;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  groupPolicy?: "open" | "allowlist" | "disabled";
  mediaMaxMb?: number;
  textChunkLimit?: number;
  /** Per-account configuration overrides */
  accounts?: Record<string, WhatsAppAccountRuntimeConfig>;
  /** Group configurations at base level */
  groups?: Record<string, WhatsAppGroupRuntimeConfig>;
}

/**
 * Token resolution result
 */
export interface WhatsAppTokenResolution {
  token: string;
  source: WhatsAppTokenSource;
}

/**
 * Resolved WhatsApp account with all configuration merged
 */
export interface ResolvedWhatsAppAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  tokenSource: WhatsAppTokenSource;
  configured: boolean;
  config: WhatsAppAccountRuntimeConfig;
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
export function getMultiAccountConfig(runtime: IAgentRuntime): WhatsAppMultiAccountConfig {
  const characterWhatsApp = runtime.character?.settings?.whatsapp as
    | WhatsAppMultiAccountConfig
    | undefined;

  return {
    enabled: characterWhatsApp?.enabled,
    accessToken: characterWhatsApp?.accessToken,
    phoneNumberId: characterWhatsApp?.phoneNumberId,
    businessAccountId: characterWhatsApp?.businessAccountId,
    webhookVerifyToken: characterWhatsApp?.webhookVerifyToken,
    apiVersion: characterWhatsApp?.apiVersion,
    dmPolicy: characterWhatsApp?.dmPolicy,
    groupPolicy: characterWhatsApp?.groupPolicy,
    mediaMaxMb: characterWhatsApp?.mediaMaxMb,
    textChunkLimit: characterWhatsApp?.textChunkLimit,
    accounts: characterWhatsApp?.accounts,
    groups: characterWhatsApp?.groups,
  };
}

/**
 * Lists all configured account IDs
 */
export function listWhatsAppAccountIds(runtime: IAgentRuntime): string[] {
  const config = getMultiAccountConfig(runtime);
  const accounts = config.accounts;
  const ids = new Set<string>();

  // Check if default account is configured
  const envToken = runtime.getSetting("WHATSAPP_ACCESS_TOKEN") as string | undefined;
  const envPhoneId = runtime.getSetting("WHATSAPP_PHONE_NUMBER_ID") as string | undefined;

  const baseConfigured = Boolean(config.accessToken?.trim() && config.phoneNumberId?.trim());
  const envConfigured = Boolean(envToken?.trim() && envPhoneId?.trim());

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

  return result.slice().sort((a, b) => a.localeCompare(b));
}

/**
 * Resolves the default account ID to use
 */
export function resolveDefaultWhatsAppAccountId(runtime: IAgentRuntime): string {
  const ids = listWhatsAppAccountIds(runtime);
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
): WhatsAppAccountRuntimeConfig | undefined {
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
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? accounts[matchKey] : undefined;
}

/**
 * Resolves the access token for a WhatsApp account
 */
export function resolveWhatsAppToken(
  runtime: IAgentRuntime,
  accountId: string
): WhatsAppTokenResolution {
  const multiConfig = getMultiAccountConfig(runtime);
  const accountConfig = getAccountConfig(runtime, accountId);

  // Check account-level config first
  if (accountConfig?.accessToken?.trim()) {
    return { token: accountConfig.accessToken.trim(), source: "config" };
  }

  // For default account, check base config
  if (accountId === DEFAULT_ACCOUNT_ID) {
    if (multiConfig.accessToken?.trim()) {
      return { token: multiConfig.accessToken.trim(), source: "config" };
    }

    // Check environment/runtime settings
    const envToken = runtime.getSetting("WHATSAPP_ACCESS_TOKEN") as string | undefined;
    if (envToken?.trim()) {
      return { token: envToken.trim(), source: "env" };
    }
  }

  return { token: "", source: "none" };
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

function mergeWhatsAppAccountConfig(
  runtime: IAgentRuntime,
  accountId: string
): WhatsAppAccountRuntimeConfig {
  const multiConfig = getMultiAccountConfig(runtime);
  const { accounts: _ignored, ...baseConfig } = multiConfig;
  const accountConfig = getAccountConfig(runtime, accountId) ?? {};

  // Get environment/runtime settings for the base config
  const envToken = runtime.getSetting("WHATSAPP_ACCESS_TOKEN") as string | undefined;
  const envPhoneId = runtime.getSetting("WHATSAPP_PHONE_NUMBER_ID") as string | undefined;
  const envBusinessId = runtime.getSetting("WHATSAPP_BUSINESS_ACCOUNT_ID") as string | undefined;
  const envWebhookToken = runtime.getSetting("WHATSAPP_WEBHOOK_VERIFY_TOKEN") as string | undefined;
  const envDmPolicy = runtime.getSetting("WHATSAPP_DM_POLICY") as string | undefined;
  const envGroupPolicy = runtime.getSetting("WHATSAPP_GROUP_POLICY") as string | undefined;

  const envConfig: WhatsAppAccountRuntimeConfig = {
    accessToken: envToken || undefined,
    phoneNumberId: envPhoneId || undefined,
    businessAccountId: envBusinessId || undefined,
    webhookVerifyToken: envWebhookToken || undefined,
    dmPolicy: envDmPolicy as WhatsAppAccountRuntimeConfig["dmPolicy"] | undefined,
    groupPolicy: envGroupPolicy as WhatsAppAccountRuntimeConfig["groupPolicy"] | undefined,
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
 * Resolves a complete WhatsApp account configuration
 */
export function resolveWhatsAppAccount(
  runtime: IAgentRuntime,
  accountId?: string | null
): ResolvedWhatsAppAccount {
  const normalizedAccountId = normalizeAccountId(accountId);
  const multiConfig = getMultiAccountConfig(runtime);

  const baseEnabled = multiConfig.enabled !== false;
  const merged = mergeWhatsAppAccountConfig(runtime, normalizedAccountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;

  const { token, source: tokenSource } = resolveWhatsAppToken(runtime, normalizedAccountId);
  const phoneNumberId = merged.phoneNumberId?.trim() || "";

  // Determine if this account is actually configured
  const configured = Boolean(token && phoneNumberId);

  return {
    accountId: normalizedAccountId,
    enabled,
    name: merged.name?.trim() || undefined,
    accessToken: token,
    phoneNumberId,
    businessAccountId: merged.businessAccountId?.trim() || undefined,
    tokenSource,
    configured,
    config: merged,
  };
}

/**
 * Lists all enabled WhatsApp accounts
 */
export function listEnabledWhatsAppAccounts(runtime: IAgentRuntime): ResolvedWhatsAppAccount[] {
  return listWhatsAppAccountIds(runtime)
    .map((accountId) => resolveWhatsAppAccount(runtime, accountId))
    .filter((account) => account.enabled && account.configured);
}

/**
 * Checks if multi-account mode is enabled
 */
export function isMultiAccountEnabled(runtime: IAgentRuntime): boolean {
  const accounts = listEnabledWhatsAppAccounts(runtime);
  return accounts.length > 1;
}

/**
 * Resolves group configuration for a specific group
 */
export function resolveWhatsAppGroupConfig(
  runtime: IAgentRuntime,
  accountId: string,
  groupId: string
): WhatsAppGroupRuntimeConfig | undefined {
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
export function isWhatsAppUserAllowed(params: {
  identifier: string;
  accountConfig: WhatsAppAccountRuntimeConfig;
  isGroup: boolean;
  groupId?: string;
  groupConfig?: WhatsAppGroupRuntimeConfig;
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
export function isWhatsAppMentionRequired(params: {
  accountConfig: WhatsAppAccountRuntimeConfig;
  groupConfig?: WhatsAppGroupRuntimeConfig;
}): boolean {
  const { groupConfig } = params;
  return groupConfig?.requireMention ?? false;
}

/**
 * Result of an async WhatsApp access check
 */
export interface WhatsAppAccessCheckResult {
  /** Whether the sender is allowed to proceed */
  allowed: boolean;
  /** If not allowed (pairing policy), the pairing code */
  pairingCode?: string;
  /** Whether a new pairing request was created */
  newPairingRequest?: boolean;
  /** Human-readable message to send to the user when blocked */
  replyMessage?: string;
}

/**
 * Checks if a user is allowed based on policy and allowlist, with async pairing support.
 *
 * For non-pairing policies, this behaves identically to `isWhatsAppUserAllowed`.
 * For the "pairing" policy, this actually checks the PairingService allowlist
 * and creates pairing requests when needed.
 *
 * @example
 * ```typescript
 * const result = await checkWhatsAppUserAccess({
 *   runtime,
 *   identifier: message.from,
 *   accountConfig,
 *   isGroup: false,
 *   metadata: { name: contact.name },
 * });
 *
 * if (!result.allowed) {
 *   if (result.replyMessage) {
 *     await sendMessage(result.replyMessage);
 *   }
 *   return; // Block message processing
 * }
 * ```
 */
export async function checkWhatsAppUserAccess(params: {
  runtime: IAgentRuntime;
  identifier: string;
  accountConfig: WhatsAppAccountRuntimeConfig;
  isGroup: boolean;
  groupId?: string;
  groupConfig?: WhatsAppGroupRuntimeConfig;
  metadata?: Record<string, string>;
}): Promise<WhatsAppAccessCheckResult> {
  const { runtime, identifier, accountConfig, isGroup, groupConfig, metadata } = params;

  if (isGroup) {
    // Group access - same logic as synchronous version
    const policy = accountConfig.groupPolicy ?? "allowlist";
    if (policy === "disabled") {
      return { allowed: false };
    }

    if (policy === "open") {
      return { allowed: true };
    }

    // Check group-specific allowlist first
    if (groupConfig?.allowFrom?.length) {
      const allowed = groupConfig.allowFrom.some((a) => String(a) === identifier);
      return { allowed };
    }

    // Check account-level group allowlist
    if (accountConfig.groupAllowFrom?.length) {
      const allowed = accountConfig.groupAllowFrom.some((a) => String(a) === identifier);
      return { allowed };
    }

    return { allowed: policy !== "allowlist" };
  }

  // DM handling
  const policy = accountConfig.dmPolicy ?? "pairing";
  if (policy === "disabled") {
    return { allowed: false };
  }

  if (policy === "open") {
    return { allowed: true };
  }

  if (policy === "pairing") {
    // Use the PairingService for actual pairing workflow
    const result: PairingCheckResult = await checkPairingAllowed(runtime, {
      channel: "whatsapp",
      senderId: identifier,
      metadata,
    });

    return {
      allowed: result.allowed,
      pairingCode: result.pairingCode,
      newPairingRequest: result.newRequest,
      replyMessage: result.replyMessage,
    };
  }

  // Allowlist policy - check static allowlist first
  if (accountConfig.allowFrom?.length) {
    const allowed = accountConfig.allowFrom.some((a) => String(a) === identifier);
    if (allowed) {
      return { allowed: true };
    }
  }

  // Also check the dynamic pairing allowlist for the allowlist policy
  const inDynamicAllowlist = await isInAllowlist(runtime, "whatsapp", identifier);
  return { allowed: inDynamicAllowlist };
}
