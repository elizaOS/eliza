/**
 * Resolves per-account Google Chat connector settings from top-level
 * env/character values (the implicit `default` account), a
 * `GOOGLE_CHAT_ACCOUNTS` JSON map, and `character.settings.googleChat` (or the
 * `google-chat` alias), merging per field. Supplies the service the space list
 * and service-account credentials for each configured account.
 * Named or unrecognized accountIds fail closed: they cannot inherit the
 * owner service-account JSON / key file from env or the top-level character
 * `settings.googleChat` identity fields.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { GoogleChatAudienceType, GoogleChatSettings } from "./types.js";

export const DEFAULT_GOOGLE_CHAT_ACCOUNT_ID = "default";

export type GoogleChatAccountConfig = Partial<Omit<GoogleChatSettings, "spaces" | "accountId">> & {
  accountId?: string;
  id?: string;
  spaces?: string[] | string;
  serviceAccountKey?: string;
  serviceAccountKeyFile?: string;
};

type GoogleChatMultiAccountConfig = GoogleChatAccountConfig & {
  accounts?: Record<string, GoogleChatAccountConfig>;
};

function stringSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function envOrSetting(runtime: IAgentRuntime, key: string): string | undefined {
  return stringSetting(runtime, key) ?? process.env[key];
}

function characterConfig(runtime: IAgentRuntime): GoogleChatMultiAccountConfig {
  const settings = runtime.character.settings as Record<string, unknown> | undefined;
  const raw = settings?.googleChat ?? settings?.["google-chat"];
  return raw && typeof raw === "object" ? (raw as GoogleChatMultiAccountConfig) : {};
}

function hasDefaultCharacterGoogleChatConfig(runtime: IAgentRuntime): boolean {
  const settings = runtime.character.settings as Record<string, unknown> | undefined;
  const raw = settings?.googleChat ?? settings?.["google-chat"];
  return Boolean(
    raw &&
      typeof raw === "object" &&
      Object.keys(raw as Record<string, unknown>).some((key) => key !== "accounts")
  );
}

function parseAccountsJson(runtime: IAgentRuntime): Record<string, GoogleChatAccountConfig> {
  const raw = stringSetting(runtime, "GOOGLE_CHAT_ACCOUNTS");
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed
          .filter(
            (item): item is GoogleChatAccountConfig => Boolean(item) && typeof item === "object"
          )
          .map((item) => [normalizeGoogleChatAccountId(item.accountId ?? item.id), item])
      );
    }
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, GoogleChatAccountConfig>)
      : {};
  } catch (error) {
    throw new ElizaError("Google Chat accounts config is not valid JSON.", {
      code: "GOOGLE_CHAT_CONFIG_INVALID",
      cause: error,
      context: { setting: "GOOGLE_CHAT_ACCOUNTS" },
      severity: "fatal",
    });
  }
}

function allAccountConfigs(runtime: IAgentRuntime): Record<string, GoogleChatAccountConfig> {
  return {
    ...(characterConfig(runtime).accounts ?? {}),
    ...parseAccountsJson(runtime),
  };
}

function accountConfig(runtime: IAgentRuntime, accountId: string): GoogleChatAccountConfig {
  const accounts = allAccountConfigs(runtime);
  return accounts[accountId] ?? accounts[normalizeGoogleChatAccountId(accountId)] ?? {};
}

function boolValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() !== "false";
  return fallback;
}

function spaceList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((space) => String(space).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((space) => space.trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizeGoogleChatAccountId(accountId?: unknown): string {
  if (typeof accountId !== "string") return DEFAULT_GOOGLE_CHAT_ACCOUNT_ID;
  const trimmed = accountId.trim();
  return trimmed || DEFAULT_GOOGLE_CHAT_ACCOUNT_ID;
}

export function listGoogleChatAccountIds(runtime: IAgentRuntime): string[] {
  const ids = new Set<string>();
  const config = characterConfig(runtime);

  if (
    envOrSetting(runtime, "GOOGLE_CHAT_SERVICE_ACCOUNT") ||
    envOrSetting(runtime, "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE") ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    config.serviceAccount ||
    config.serviceAccountFile ||
    config.serviceAccountKey ||
    config.serviceAccountKeyFile ||
    hasDefaultCharacterGoogleChatConfig(runtime) ||
    envOrSetting(runtime, "GOOGLE_CHAT_ENABLED") !== undefined ||
    envOrSetting(runtime, "GOOGLE_CHAT_AUDIENCE") !== undefined ||
    envOrSetting(runtime, "GOOGLE_CHAT_AUDIENCE_TYPE") !== undefined ||
    envOrSetting(runtime, "GOOGLE_CHAT_WEBHOOK_PATH") !== undefined ||
    envOrSetting(runtime, "GOOGLE_CHAT_SPACES") !== undefined ||
    envOrSetting(runtime, "GOOGLE_CHAT_REQUIRE_MENTION") !== undefined ||
    envOrSetting(runtime, "GOOGLE_CHAT_BOT_USER") !== undefined ||
    envOrSetting(runtime, "GOOGLE_CHAT_DEFAULT_ACCOUNT_ID") !== undefined ||
    envOrSetting(runtime, "GOOGLE_CHAT_ACCOUNT_ID") !== undefined
  ) {
    ids.add(DEFAULT_GOOGLE_CHAT_ACCOUNT_ID);
  }

  for (const id of Object.keys(allAccountConfigs(runtime))) {
    ids.add(normalizeGoogleChatAccountId(id));
  }

  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultGoogleChatAccountId(runtime: IAgentRuntime): string {
  const requested =
    stringSetting(runtime, "GOOGLE_CHAT_DEFAULT_ACCOUNT_ID") ??
    stringSetting(runtime, "GOOGLE_CHAT_ACCOUNT_ID");
  if (requested) return normalizeGoogleChatAccountId(requested);

  const ids = listGoogleChatAccountIds(runtime);
  return ids.includes(DEFAULT_GOOGLE_CHAT_ACCOUNT_ID)
    ? DEFAULT_GOOGLE_CHAT_ACCOUNT_ID
    : (ids[0] ?? DEFAULT_GOOGLE_CHAT_ACCOUNT_ID);
}

export function readGoogleChatAccountId(...sources: unknown[]): string | undefined {
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const record = source as Record<string, unknown>;
    const parameters =
      record.parameters && typeof record.parameters === "object"
        ? (record.parameters as Record<string, unknown>)
        : {};
    const data =
      record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>)
        : {};
    const metadata =
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : {};
    const googleChat =
      data.googleChat && typeof data.googleChat === "object"
        ? (data.googleChat as Record<string, unknown>)
        : {};
    const value =
      record.accountId ??
      parameters.accountId ??
      data.accountId ??
      googleChat.accountId ??
      metadata.accountId;
    if (typeof value === "string" && value.trim()) return normalizeGoogleChatAccountId(value);
  }
  return undefined;
}

export function resolveGoogleChatAccountSettings(
  runtime: IAgentRuntime,
  requestedAccountId?: string | null
): GoogleChatSettings {
  const accountId = normalizeGoogleChatAccountId(
    requestedAccountId ?? resolveDefaultGoogleChatAccountId(runtime)
  );
  const base = characterConfig(runtime);
  const account = accountConfig(runtime, accountId);
  const allowOwnerBind = accountId === DEFAULT_GOOGLE_CHAT_ACCOUNT_ID;
  const webhookPath =
    account.webhookPath ??
    base.webhookPath ??
    (allowOwnerBind ? envOrSetting(runtime, "GOOGLE_CHAT_WEBHOOK_PATH") : undefined) ??
    "/googlechat";

  return {
    accountId,
    serviceAccount:
      account.serviceAccount ??
      account.serviceAccountKey ??
      (allowOwnerBind ? base.serviceAccount : undefined) ??
      (allowOwnerBind ? base.serviceAccountKey : undefined) ??
      (allowOwnerBind ? envOrSetting(runtime, "GOOGLE_CHAT_SERVICE_ACCOUNT") : undefined),
    serviceAccountFile:
      account.serviceAccountFile ??
      account.serviceAccountKeyFile ??
      (allowOwnerBind ? base.serviceAccountFile : undefined) ??
      (allowOwnerBind ? base.serviceAccountKeyFile : undefined) ??
      (allowOwnerBind ? envOrSetting(runtime, "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE") : undefined) ??
      (allowOwnerBind ? process.env.GOOGLE_APPLICATION_CREDENTIALS : undefined),
    audienceType: (account.audienceType ??
      base.audienceType ??
      (allowOwnerBind ? envOrSetting(runtime, "GOOGLE_CHAT_AUDIENCE_TYPE") : undefined) ??
      "app-url") as GoogleChatAudienceType,
    audience:
      account.audience ??
      base.audience ??
      (allowOwnerBind ? envOrSetting(runtime, "GOOGLE_CHAT_AUDIENCE") : undefined) ??
      "",
    webhookPath: webhookPath.startsWith("/") ? webhookPath : `/${webhookPath}`,
    spaces: spaceList(
      account.spaces ??
        base.spaces ??
        (allowOwnerBind ? envOrSetting(runtime, "GOOGLE_CHAT_SPACES") : undefined)
    ),
    requireMention: boolValue(
      account.requireMention ??
        base.requireMention ??
        (allowOwnerBind ? envOrSetting(runtime, "GOOGLE_CHAT_REQUIRE_MENTION") : undefined),
      true
    ),
    enabled: boolValue(
      account.enabled ??
        base.enabled ??
        (allowOwnerBind ? envOrSetting(runtime, "GOOGLE_CHAT_ENABLED") : undefined),
      true
    ),
    botUser:
      account.botUser ??
      base.botUser ??
      (allowOwnerBind ? envOrSetting(runtime, "GOOGLE_CHAT_BOT_USER") : undefined),
  };
}
