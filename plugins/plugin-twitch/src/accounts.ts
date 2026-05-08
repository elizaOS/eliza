import type { IAgentRuntime } from "@elizaos/core";
import type { TwitchRole, TwitchSettings } from "./types.js";

export const DEFAULT_TWITCH_ACCOUNT_ID = "default";

export type TwitchAccountConfig = Partial<
  Omit<TwitchSettings, "additionalChannels" | "allowedRoles" | "allowedUserIds" | "accountId">
> & {
  accountId?: string;
  id?: string;
  additionalChannels?: string[] | string;
  channels?: string[] | string;
  allowedRoles?: TwitchRole[] | string;
  allowedUserIds?: string[] | string;
};

type TwitchMultiAccountConfig = TwitchAccountConfig & {
  accounts?: Record<string, TwitchAccountConfig>;
};

function stringSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function characterConfig(runtime: IAgentRuntime): TwitchMultiAccountConfig {
  const settings = runtime.character?.settings as Record<string, unknown> | undefined;
  const raw = settings?.twitch;
  return raw && typeof raw === "object" ? (raw as TwitchMultiAccountConfig) : {};
}

function parseAccountsJson(runtime: IAgentRuntime): Record<string, TwitchAccountConfig> {
  const raw = stringSetting(runtime, "TWITCH_ACCOUNTS");
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed
          .filter((item): item is TwitchAccountConfig => Boolean(item) && typeof item === "object")
          .map((item) => [normalizeTwitchAccountId(item.accountId ?? item.id), item])
      );
    }
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, TwitchAccountConfig>)
      : {};
  } catch {
    return {};
  }
}

function allAccountConfigs(runtime: IAgentRuntime): Record<string, TwitchAccountConfig> {
  return {
    ...(characterConfig(runtime).accounts ?? {}),
    ...parseAccountsJson(runtime),
  };
}

function accountConfig(runtime: IAgentRuntime, accountId: string): TwitchAccountConfig {
  const accounts = allAccountConfigs(runtime);
  return accounts[accountId] ?? accounts[normalizeTwitchAccountId(accountId)] ?? {};
}

function boolValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return fallback;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function roleList(value: unknown): TwitchRole[] {
  const values = stringList(value).map((role) => role.toLowerCase() as TwitchRole);
  return values.length ? values : ["all"];
}

export function normalizeTwitchAccountId(accountId?: unknown): string {
  if (typeof accountId !== "string") return DEFAULT_TWITCH_ACCOUNT_ID;
  const trimmed = accountId.trim();
  return trimmed || DEFAULT_TWITCH_ACCOUNT_ID;
}

export function listTwitchAccountIds(runtime: IAgentRuntime): string[] {
  const ids = new Set<string>();
  const config = characterConfig(runtime);

  if (stringSetting(runtime, "TWITCH_ACCESS_TOKEN") || config.accessToken) {
    ids.add(DEFAULT_TWITCH_ACCOUNT_ID);
  }

  for (const id of Object.keys(allAccountConfigs(runtime))) {
    ids.add(normalizeTwitchAccountId(id));
  }

  return Array.from(ids.size ? ids : new Set([DEFAULT_TWITCH_ACCOUNT_ID])).sort((a, b) =>
    a.localeCompare(b)
  );
}

export function resolveDefaultTwitchAccountId(runtime: IAgentRuntime): string {
  const requested =
    stringSetting(runtime, "TWITCH_DEFAULT_ACCOUNT_ID") ?? stringSetting(runtime, "TWITCH_ACCOUNT_ID");
  if (requested) return normalizeTwitchAccountId(requested);

  const ids = listTwitchAccountIds(runtime);
  return ids.includes(DEFAULT_TWITCH_ACCOUNT_ID) ? DEFAULT_TWITCH_ACCOUNT_ID : ids[0];
}

export function readTwitchAccountId(...sources: unknown[]): string | undefined {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const record = source as Record<string, unknown>;
    const parameters =
      record.parameters && typeof record.parameters === "object"
        ? (record.parameters as Record<string, unknown>)
        : {};
    const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
    const metadata =
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : {};
    const twitch =
      data.twitch && typeof data.twitch === "object" ? (data.twitch as Record<string, unknown>) : {};
    const value =
      record.accountId ?? parameters.accountId ?? data.accountId ?? twitch.accountId ?? metadata.accountId;
    if (typeof value === "string" && value.trim()) return normalizeTwitchAccountId(value);
  }
  return undefined;
}

export function resolveTwitchAccountSettings(
  runtime: IAgentRuntime,
  requestedAccountId?: string | null
): TwitchSettings {
  const accountId = normalizeTwitchAccountId(
    requestedAccountId ?? resolveDefaultTwitchAccountId(runtime)
  );
  const base = characterConfig(runtime);
  const account = accountConfig(runtime, accountId);
  const allowEnv = accountId === DEFAULT_TWITCH_ACCOUNT_ID;

  return {
    accountId,
    username: account.username ?? base.username ?? (allowEnv ? stringSetting(runtime, "TWITCH_USERNAME") : undefined) ?? "",
    clientId: account.clientId ?? base.clientId ?? (allowEnv ? stringSetting(runtime, "TWITCH_CLIENT_ID") : undefined) ?? "",
    accessToken:
      account.accessToken ??
      base.accessToken ??
      (allowEnv ? stringSetting(runtime, "TWITCH_ACCESS_TOKEN") : undefined) ??
      "",
    clientSecret:
      account.clientSecret ??
      base.clientSecret ??
      (allowEnv ? stringSetting(runtime, "TWITCH_CLIENT_SECRET") : undefined),
    refreshToken:
      account.refreshToken ??
      base.refreshToken ??
      (allowEnv ? stringSetting(runtime, "TWITCH_REFRESH_TOKEN") : undefined),
    channel: account.channel ?? base.channel ?? (allowEnv ? stringSetting(runtime, "TWITCH_CHANNEL") : undefined) ?? "",
    additionalChannels: stringList(
      account.additionalChannels ??
        account.channels ??
        base.additionalChannels ??
        base.channels ??
        (allowEnv ? stringSetting(runtime, "TWITCH_CHANNELS") : undefined)
    ),
    requireMention: boolValue(
      account.requireMention ??
        base.requireMention ??
        (allowEnv ? stringSetting(runtime, "TWITCH_REQUIRE_MENTION") : undefined)
    ),
    allowedRoles: roleList(
      account.allowedRoles ?? base.allowedRoles ?? (allowEnv ? stringSetting(runtime, "TWITCH_ALLOWED_ROLES") : undefined)
    ),
    allowedUserIds: stringList(account.allowedUserIds ?? base.allowedUserIds),
    enabled: boolValue(account.enabled ?? base.enabled, true),
  };
}
