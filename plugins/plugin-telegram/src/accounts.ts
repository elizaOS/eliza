/**
 * Multi-account configuration resolution for Telegram. Reads
 * `character.settings.telegram` (a single bot token or an `accounts` map) plus
 * `TELEGRAM_BOT_TOKEN`/env fallbacks and resolves each enabled account to a
 * `ResolvedTelegramAccount` the service launches a bot for. `default` is the
 * synthetic id for the single-account configuration.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";

export const DEFAULT_ACCOUNT_ID = "default";

export interface TelegramAccountConfig {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  apiRoot?: string;
  allowedChats?: string[];
  autoReply?: boolean;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  groupPolicy?: "open" | "disabled" | "allowlist";
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  replyToMode?: "off" | "first" | "all";
  groups?: Record<
    string,
    | {
        requireMention?: boolean;
        enabled?: boolean;
        allowFrom?: Array<string | number>;
        topics?: Record<
          string,
          | {
              requireMention?: boolean;
              enabled?: boolean;
              allowFrom?: Array<string | number>;
            }
          | undefined
        >;
      }
    | undefined
  >;
  personal?: {
    phone?: string;
    appId?: string;
    appHash?: string;
    session?: string;
    enabled?: boolean;
  };
}

export interface TelegramMultiAccountConfig {
  enabled?: boolean;
  botToken?: string;
  apiRoot?: string;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  groupPolicy?: "open" | "disabled" | "allowlist";
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  replyToMode?: "off" | "first" | "all";
  groups?: TelegramAccountConfig["groups"];
  accounts?: Record<string, TelegramAccountConfig>;
}

export interface ResolvedTelegramAccount {
  accountId: string;
  enabled: boolean;
  name?: string;
  botToken?: string;
  apiRoot: string;
  config: TelegramAccountConfig;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getRuntimeAccountTokens(
  runtime: IAgentRuntime,
): Record<string, string> {
  const raw = runtime.getSetting("TELEGRAM_ACCOUNT_TOKENS_JSON");
  if (typeof raw !== "string" || !raw.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // error-policy:J2 runtime projection corruption must retain its parse cause.
    throw new ElizaError("Telegram account token settings are not valid JSON", {
      code: "TELEGRAM_ACCOUNT_TOKENS_INVALID",
      cause: error,
      severity: "fatal",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ElizaError("Telegram account token settings must be an object", {
      code: "TELEGRAM_ACCOUNT_TOKENS_INVALID",
      severity: "fatal",
    });
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(
      ([accountId, token]) => {
        const value = readNonEmptyString(token);
        if (!value) {
          throw new ElizaError(
            `Telegram account token is missing for ${JSON.stringify(accountId)}`,
            {
              code: "TELEGRAM_ACCOUNT_TOKEN_MISSING",
              context: { accountId },
              severity: "fatal",
            },
          );
        }
        return [accountId, value];
      },
    ),
  );
}

export function normalizeTelegramAccountId(accountId?: string | null): string {
  return readNonEmptyString(accountId) ?? DEFAULT_ACCOUNT_ID;
}

export function getTelegramMultiAccountConfig(
  runtime: IAgentRuntime,
): TelegramMultiAccountConfig {
  const characterTelegram = runtime.character?.settings?.telegram as
    | TelegramMultiAccountConfig
    | undefined;

  return {
    enabled: characterTelegram?.enabled,
    botToken: characterTelegram?.botToken,
    apiRoot: characterTelegram?.apiRoot,
    dmPolicy: characterTelegram?.dmPolicy,
    groupPolicy: characterTelegram?.groupPolicy,
    allowFrom: characterTelegram?.allowFrom,
    groupAllowFrom: characterTelegram?.groupAllowFrom,
    replyToMode: characterTelegram?.replyToMode,
    groups: characterTelegram?.groups,
    accounts: characterTelegram?.accounts,
  };
}

export function listTelegramAccountIds(runtime: IAgentRuntime): string[] {
  const accounts = getTelegramMultiAccountConfig(runtime).accounts;
  if (!accounts || typeof accounts !== "object") {
    return [DEFAULT_ACCOUNT_ID];
  }
  const ids = Object.keys(accounts).filter(Boolean);
  return ids.length > 0
    ? ids.slice().sort((a, b) => a.localeCompare(b))
    : [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultTelegramAccountId(
  runtime: IAgentRuntime,
): string {
  const ids = listTelegramAccountIds(runtime);
  return ids.includes(DEFAULT_ACCOUNT_ID)
    ? DEFAULT_ACCOUNT_ID
    : (ids[0] ?? DEFAULT_ACCOUNT_ID);
}

function getAccountConfig(
  runtime: IAgentRuntime,
  accountId: string,
): TelegramAccountConfig | undefined {
  const accounts = getTelegramMultiAccountConfig(runtime).accounts;
  return accounts && typeof accounts === "object"
    ? accounts[accountId]
    : undefined;
}

function resolveTelegramBotToken(
  runtime: IAgentRuntime,
  accountId: string,
  merged: TelegramAccountConfig,
): string | undefined {
  const configToken = readNonEmptyString(merged.botToken);
  if (configToken) {
    return configToken;
  }
  const accountToken = readNonEmptyString(
    getRuntimeAccountTokens(runtime)[accountId],
  );
  if (accountToken) {
    return accountToken;
  }
  if (accountId !== DEFAULT_ACCOUNT_ID) {
    return undefined;
  }
  return (
    readNonEmptyString(runtime.getSetting("TELEGRAM_BOT_TOKEN")) ??
    readNonEmptyString(process.env.TELEGRAM_BOT_TOKEN)
  );
}

export function resolveTelegramAccount(
  runtime: IAgentRuntime,
  accountId?: string | null,
): ResolvedTelegramAccount {
  const normalizedAccountId = normalizeTelegramAccountId(accountId);
  const multi = getTelegramMultiAccountConfig(runtime);
  const accountConfig = getAccountConfig(runtime, normalizedAccountId) ?? {};
  const merged: TelegramAccountConfig = {
    enabled: multi.enabled,
    botToken: multi.botToken,
    apiRoot: multi.apiRoot,
    dmPolicy: multi.dmPolicy,
    groupPolicy: multi.groupPolicy,
    allowFrom: multi.allowFrom,
    groupAllowFrom: multi.groupAllowFrom,
    replyToMode: multi.replyToMode,
    groups: multi.groups,
    ...accountConfig,
  };
  const apiRoot =
    readNonEmptyString(merged.apiRoot) ??
    readNonEmptyString(runtime.getSetting("TELEGRAM_API_ROOT")) ??
    readNonEmptyString(process.env.TELEGRAM_API_ROOT) ??
    "https://api.telegram.org";

  return {
    accountId: normalizedAccountId,
    enabled: multi.enabled !== false && merged.enabled !== false,
    name: readNonEmptyString(merged.name),
    botToken: resolveTelegramBotToken(runtime, normalizedAccountId, merged),
    apiRoot,
    config: merged,
  };
}

export function listEnabledTelegramAccounts(
  runtime: IAgentRuntime,
): ResolvedTelegramAccount[] {
  return listTelegramAccountIds(runtime)
    .map((accountId) => resolveTelegramAccount(runtime, accountId))
    .filter((account) => account.enabled && account.botToken);
}

/**
 * Whether an account declares a usable personal (MTProto user-account) identity:
 * a personal block that isn't explicitly disabled and carries at least a phone
 * number or a saved session. This is the OWNER signal — the human user the agent
 * can act through — distinct from the bot identity (botToken) it acts AS.
 */
export function isTelegramPersonalEnabled(
  account: ResolvedTelegramAccount,
): boolean {
  const personal = account.config.personal;
  if (!personal || personal.enabled === false) {
    return false;
  }
  return Boolean(
    readNonEmptyString(personal.phone) || readNonEmptyString(personal.session),
  );
}

/**
 * Stable external id for an account's personal identity, used as the binding key
 * the owner-binding access gate matches against. Derived from the phone number;
 * undefined when no phone is configured (the gate then can't resolve a binding,
 * which correctly keeps the account blocked).
 */
export function telegramPersonalExternalId(
  account: ResolvedTelegramAccount,
): string | undefined {
  const phone = readNonEmptyString(account.config.personal?.phone);
  return phone ? `tg-user:${phone}` : undefined;
}

/**
 * Accounts that declare a personal (user-account) identity. Separate from
 * listEnabledTelegramAccounts (which is the bot-service's view — accounts with a
 * botToken to long-poll); a personal-only account has no botToken and must never
 * reach the bot service, only the connector-account provider.
 */
export function listPersonalTelegramAccounts(
  runtime: IAgentRuntime,
): ResolvedTelegramAccount[] {
  return listTelegramAccountIds(runtime)
    .map((accountId) => resolveTelegramAccount(runtime, accountId))
    .filter((account) => account.enabled && isTelegramPersonalEnabled(account));
}
