import type { IAgentRuntime } from "@elizaos/core";
import type { InstagramConfig } from "./types";

export const DEFAULT_INSTAGRAM_ACCOUNT_ID = "default";

export type InstagramAccountConfig = Partial<InstagramConfig> & {
  accountId?: string;
  id?: string;
};

type InstagramMultiAccountConfig = InstagramAccountConfig & {
  accounts?: Record<string, InstagramAccountConfig>;
};

function stringSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function characterConfig(runtime: IAgentRuntime): InstagramMultiAccountConfig {
  const settings = runtime.character?.settings as Record<string, unknown> | undefined;
  const raw = settings?.instagram;
  return raw && typeof raw === "object" ? (raw as InstagramMultiAccountConfig) : {};
}

function parseAccountsJson(runtime: IAgentRuntime): Record<string, InstagramAccountConfig> {
  const raw = stringSetting(runtime, "INSTAGRAM_ACCOUNTS");
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed
          .filter(
            (item): item is InstagramAccountConfig => Boolean(item) && typeof item === "object"
          )
          .map((item) => [normalizeInstagramAccountId(item.accountId ?? item.id), item])
      );
    }
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, InstagramAccountConfig>)
      : {};
  } catch {
    return {};
  }
}

function allAccountConfigs(runtime: IAgentRuntime): Record<string, InstagramAccountConfig> {
  return {
    ...(characterConfig(runtime).accounts ?? {}),
    ...parseAccountsJson(runtime),
  };
}

function accountConfig(runtime: IAgentRuntime, accountId: string): InstagramAccountConfig {
  const accounts = allAccountConfigs(runtime);
  return accounts[accountId] ?? accounts[normalizeInstagramAccountId(accountId)] ?? {};
}

function boolValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return fallback;
}

export function normalizeInstagramAccountId(accountId?: unknown): string {
  if (typeof accountId !== "string") return DEFAULT_INSTAGRAM_ACCOUNT_ID;
  const trimmed = accountId.trim();
  return trimmed || DEFAULT_INSTAGRAM_ACCOUNT_ID;
}

export function listInstagramAccountIds(runtime: IAgentRuntime): string[] {
  const ids = new Set<string>();
  const config = characterConfig(runtime);

  if (stringSetting(runtime, "INSTAGRAM_USERNAME") || config.username) {
    ids.add(DEFAULT_INSTAGRAM_ACCOUNT_ID);
  }

  for (const id of Object.keys(allAccountConfigs(runtime))) {
    ids.add(normalizeInstagramAccountId(id));
  }

  return Array.from(ids.size ? ids : new Set([DEFAULT_INSTAGRAM_ACCOUNT_ID])).sort((a, b) =>
    a.localeCompare(b)
  );
}

export function resolveDefaultInstagramAccountId(runtime: IAgentRuntime): string {
  const requested =
    stringSetting(runtime, "INSTAGRAM_DEFAULT_ACCOUNT_ID") ??
    stringSetting(runtime, "INSTAGRAM_ACCOUNT_ID");
  if (requested) return normalizeInstagramAccountId(requested);

  const ids = listInstagramAccountIds(runtime);
  return ids.includes(DEFAULT_INSTAGRAM_ACCOUNT_ID)
    ? DEFAULT_INSTAGRAM_ACCOUNT_ID
    : (ids[0] ?? DEFAULT_INSTAGRAM_ACCOUNT_ID);
}

export function readInstagramAccountId(...sources: unknown[]): string | undefined {
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
    const instagram =
      data.instagram && typeof data.instagram === "object"
        ? (data.instagram as Record<string, unknown>)
        : {};
    const value =
      record.accountId ??
      parameters.accountId ??
      data.accountId ??
      instagram.accountId ??
      metadata.accountId;
    if (typeof value === "string" && value.trim()) return normalizeInstagramAccountId(value);
  }
  return undefined;
}

export function resolveInstagramAccountConfig(
  runtime: IAgentRuntime,
  requestedAccountId?: string | null
): InstagramConfig {
  const accountId = normalizeInstagramAccountId(
    requestedAccountId ?? resolveDefaultInstagramAccountId(runtime)
  );
  const base = characterConfig(runtime);
  const account = accountConfig(runtime, accountId);
  const allowEnv = accountId === DEFAULT_INSTAGRAM_ACCOUNT_ID;

  return {
    accountId,
    username:
      account.username ??
      base.username ??
      (allowEnv ? stringSetting(runtime, "INSTAGRAM_USERNAME") : undefined) ??
      "",
    password:
      account.password ??
      base.password ??
      (allowEnv ? stringSetting(runtime, "INSTAGRAM_PASSWORD") : undefined) ??
      "",
    verificationCode:
      account.verificationCode ??
      base.verificationCode ??
      (allowEnv ? stringSetting(runtime, "INSTAGRAM_VERIFICATION_CODE") : undefined),
    proxy:
      account.proxy ??
      base.proxy ??
      (allowEnv ? stringSetting(runtime, "INSTAGRAM_PROXY") : undefined),
    autoRespondToDms: boolValue(
      account.autoRespondToDms ??
        base.autoRespondToDms ??
        (allowEnv ? stringSetting(runtime, "INSTAGRAM_AUTO_RESPOND_DMS") : undefined)
    ),
    autoRespondToComments: boolValue(
      account.autoRespondToComments ??
        base.autoRespondToComments ??
        (allowEnv ? stringSetting(runtime, "INSTAGRAM_AUTO_RESPOND_COMMENTS") : undefined)
    ),
    pollingInterval: Number.parseInt(
      String(
        account.pollingInterval ??
          base.pollingInterval ??
          (allowEnv ? stringSetting(runtime, "INSTAGRAM_POLLING_INTERVAL") : undefined) ??
          "60"
      ),
      10
    ),
  };
}
