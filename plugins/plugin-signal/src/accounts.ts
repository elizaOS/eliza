/**
 * Resolves Signal account configuration by merging environment defaults,
 * character `settings.signal`, and per-account overrides into concrete
 * `ResolvedSignalAccount` records.
 *
 * The service and the connector-account provider both read accounts through
 * here. Account IDs are lowercased via `normalizeAccountId`, and `"default"`
 * (`DEFAULT_ACCOUNT_ID`) is the sentinel for single-account env-only setups.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";

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
  /** Compatibility alias from the public SignalConfig surface. */
  dmPolicy?: SignalDmConfig["policy"];
  /** Compatibility alias from the public SignalConfig surface. */
  allowFrom?: Array<string | number>;
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
  /** Base DM access policy, inherited by every account unless overridden */
  dm?: SignalDmConfig;
  /** Compatibility alias from the public SignalConfig surface. */
  dmPolicy?: SignalDmConfig["policy"];
  /** Compatibility alias from the public SignalConfig surface. */
  allowFrom?: Array<string | number>;
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
 * Gets the account configuration records from runtime settings
 */
function getMultiAccountConfig(runtime: IAgentRuntime): SignalMultiAccountConfig {
  const characterSignal = runtime.character.settings?.signal as
    | SignalMultiAccountConfig
    | undefined;

  return {
    enabled: characterSignal?.enabled,
    account: characterSignal?.account,
    httpUrl: characterSignal?.httpUrl,
    authDir: characterSignal?.authDir,
    dm: characterSignal?.dm,
    dmPolicy: characterSignal?.dmPolicy,
    allowFrom: characterSignal?.allowFrom,
    accounts: characterSignal?.accounts,
  };
}

function indexSignalAccountConfigs(
  accounts: Record<string, SignalAccountConfig>
): Map<string, SignalAccountConfig> {
  const normalizedConfigs = new Map<
    string,
    { configuredId: string; config: SignalAccountConfig }
  >();
  for (const [configuredId, accountConfig] of Object.entries(accounts)) {
    if (!configuredId) continue;
    const normalized = normalizeAccountId(configuredId);
    const existing = normalizedConfigs.get(normalized);
    if (existing !== undefined && existing.configuredId !== configuredId) {
      throw new ElizaError("Signal account identifiers collide after normalization", {
        code: "SIGNAL_ACCOUNT_ID_COLLISION",
        context: {
          normalizedAccountId: normalized,
          configuredIds: [existing.configuredId, configuredId],
        },
      });
    }
    normalizedConfigs.set(normalized, {
      configuredId,
      config: accountConfig,
    });
  }
  return new Map([...normalizedConfigs].map(([accountId, entry]) => [accountId, entry.config]));
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

  // Enumerate under the same normalized (lowercased) identity that
  // `resolveSignalAccount`/`getAccountConfig` use for lookup, otherwise an
  // uppercase-keyed account (`"Work"`) is listed raw but resolves under
  // `"work"`, misses its overrides, and is silently dropped (issue #22680).
  const ids = Array.from(indexSignalAccountConfigs(accounts).keys());
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return ids.slice().sort((a: string, b: string) => a.localeCompare(b));
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

  // Resolve through the same collision-detecting normalized index used for
  // enumeration so the public single-account resolver cannot silently choose
  // one of two ambiguous configured keys.
  return indexSignalAccountConfigs(accounts).get(accountId);
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
  const normalizedDm = filterDefined({
    policy: multiConfig.dmPolicy,
    allowFrom: multiConfig.allowFrom,
    ...filterDefined(multiConfig.dm ?? {}),
    ...(accountConfig.dmPolicy !== undefined ? { policy: accountConfig.dmPolicy } : {}),
    ...(accountConfig.allowFrom !== undefined ? { allowFrom: accountConfig.allowFrom } : {}),
    ...filterDefined(accountConfig.dm ?? {}),
  });

  return {
    ...filterDefined(envConfig),
    ...filterDefined(baseConfig),
    ...filterDefined(accountConfig),
    ...(Object.keys(normalizedDm).length > 0 ? { dm: normalizedDm } : {}),
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
 * Checks whether more than one enabled account is configured
 */
export function isMultiAccountEnabled(runtime: IAgentRuntime): boolean {
  const accounts = listEnabledSignalAccounts(runtime);
  return accounts.length > 1;
}
