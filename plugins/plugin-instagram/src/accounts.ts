/**
 * Resolves per-account Instagram connector config from three sources — top-level
 * env/character values (the implicit `default` account), an `INSTAGRAM_ACCOUNTS`
 * JSON map, and `character.settings.instagram` — merging per field. Supplies
 * `InstagramService` the account id list and credentials for each configured account.
 */
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
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

function isAccountConfig(value: unknown): value is InstagramAccountConfig {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidAccountsConfig(
  message: string,
  context: Record<string, unknown>,
  cause?: unknown
): ElizaError {
  return new ElizaError(message, {
    code: "INSTAGRAM_CONFIG_INVALID",
    ...(cause === undefined ? {} : { cause }),
    context,
    severity: "fatal",
  });
}

function indexAccountConfigs(
  entries: Iterable<readonly [unknown, unknown]>,
  setting: string
): Record<string, InstagramAccountConfig> {
  const configs = new Map<string, InstagramAccountConfig>();
  for (const [rawId, value] of entries) {
    if (!isAccountConfig(value)) continue;
    const accountId = normalizeInstagramAccountId(rawId);
    if (configs.has(accountId)) {
      throw invalidAccountsConfig(
        `Instagram accounts config contains duplicate account id ${JSON.stringify(accountId)} after normalization.`,
        { setting, accountId }
      );
    }
    configs.set(accountId, value);
  }
  return Object.fromEntries(configs);
}

function parseAccountsJson(runtime: IAgentRuntime): Record<string, InstagramAccountConfig> {
  const raw = stringSetting(runtime, "INSTAGRAM_ACCOUNTS");
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // error-policy:J2 preserve the parse category without retaining provider
    // configuration bytes, which may contain access tokens or app secrets.
    throw invalidAccountsConfig(
      "Instagram accounts config is not valid JSON.",
      { setting: "INSTAGRAM_ACCOUNTS" },
      new SyntaxError("Invalid JSON")
    );
  }
  if (Array.isArray(parsed)) {
    return indexAccountConfigs(
      parsed.map((item) => [isAccountConfig(item) ? (item.accountId ?? item.id) : undefined, item]),
      "INSTAGRAM_ACCOUNTS"
    );
  }
  if (!isAccountConfig(parsed)) {
    throw invalidAccountsConfig("Instagram accounts config must be a JSON object or array.", {
      setting: "INSTAGRAM_ACCOUNTS",
      valueType: parsed === null ? "null" : typeof parsed,
    });
  }
  // Normalize object-form keys at parse time so listInstagramAccountIds()
  // (which trims when building the id list) and accountConfig() (which looks
  // up the map key) agree: a padded " brand " key otherwise lists as `brand`
  // but resolves to an empty config.
  return indexAccountConfigs(Object.entries(parsed), "INSTAGRAM_ACCOUNTS");
}

function allAccountConfigs(runtime: IAgentRuntime): Record<string, InstagramAccountConfig> {
  const characterAccounts = characterConfig(runtime).accounts;
  return {
    ...(characterAccounts && isAccountConfig(characterAccounts)
      ? indexAccountConfigs(
          Object.entries(characterAccounts),
          "character.settings.instagram.accounts"
        )
      : {}),
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

  if (
    stringSetting(runtime, "INSTAGRAM_ACCESS_TOKEN") ||
    stringSetting(runtime, "INSTAGRAM_GRAPH_ACCOUNT_ID") ||
    config.accessToken ||
    config.instagramAccountId
  ) {
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
    accessToken:
      account.accessToken ??
      base.accessToken ??
      (allowEnv ? stringSetting(runtime, "INSTAGRAM_ACCESS_TOKEN") : undefined) ??
      "",
    instagramAccountId:
      account.instagramAccountId ??
      base.instagramAccountId ??
      (allowEnv ? stringSetting(runtime, "INSTAGRAM_GRAPH_ACCOUNT_ID") : undefined) ??
      "",
    appSecret:
      account.appSecret ??
      base.appSecret ??
      (allowEnv ? stringSetting(runtime, "INSTAGRAM_APP_SECRET") : undefined),
    webhookVerifyToken:
      account.webhookVerifyToken ??
      base.webhookVerifyToken ??
      (allowEnv ? stringSetting(runtime, "INSTAGRAM_WEBHOOK_VERIFY_TOKEN") : undefined),
    graphBaseUrl:
      account.graphBaseUrl ??
      base.graphBaseUrl ??
      (allowEnv ? stringSetting(runtime, "INSTAGRAM_GRAPH_BASE_URL") : undefined),
    graphApiVersion:
      account.graphApiVersion ??
      base.graphApiVersion ??
      (allowEnv ? stringSetting(runtime, "INSTAGRAM_GRAPH_API_VERSION") : undefined),
    requestTimeoutMs: Number.parseInt(
      String(
        account.requestTimeoutMs ??
          base.requestTimeoutMs ??
          (allowEnv ? stringSetting(runtime, "INSTAGRAM_REQUEST_TIMEOUT_MS") : undefined) ??
          "15000"
      ),
      10
    ),
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
