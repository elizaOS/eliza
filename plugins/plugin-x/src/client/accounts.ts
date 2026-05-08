import type { IAgentRuntime } from "@elizaos/core";
import type { TwitterConfig } from "../environment";
import type { TwitterClientState } from "../types";
import { getSetting } from "../utils/settings";
import type { TwitterAuthMode } from "./auth-providers/types";

export const DEFAULT_X_ACCOUNT_ID = "default";

export interface XAccountCredentials {
  authMode?: TwitterAuthMode;
  apiKey?: string;
  apiSecretKey?: string;
  accessToken?: string;
  accessTokenSecret?: string;
  clientId?: string;
  redirectUri?: string;
  scopes?: string;
}

export interface XConnectorAccountRecord {
  accountId: string;
  source?: "x" | "twitter";
  credentials?: XAccountCredentials;
  settings?: Partial<Record<keyof TwitterConfig | string, string | undefined>>;
  metadata?: Record<string, unknown>;
}

export interface XConnectorAccountStore {
  getAccount(accountId: string): Promise<XConnectorAccountRecord | null>;
}

export interface RuntimeWithXConnectorAccounts {
  getConnectorAccount?: (query: {
    source: "x";
    accountId: string;
  }) => Promise<XConnectorAccountRecord | null>;
  getConnectorAccountStore?: (source: "x") => XConnectorAccountStore | null;
}

type RawAccountRecord = Record<string, unknown>;

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeXAccountId(value: unknown): string {
  return nonEmptyString(value) ?? DEFAULT_X_ACCOUNT_ID;
}

export function resolveDefaultXAccountId(
  runtime: IAgentRuntime | null | undefined,
  state?: TwitterClientState,
): string {
  return normalizeXAccountId(
    state?.accountId ??
      state?.TWITTER_DEFAULT_ACCOUNT_ID ??
      state?.TWITTER_ACCOUNT_ID ??
      getSetting(runtime, "TWITTER_DEFAULT_ACCOUNT_ID") ??
      getSetting(runtime, "TWITTER_ACCOUNT_ID") ??
      getSetting(runtime, "X_DEFAULT_ACCOUNT_ID") ??
      getSetting(runtime, "X_ACCOUNT_ID"),
  );
}

export function resolveRequestedXAccountId(
  runtime: IAgentRuntime | null | undefined,
  state?: TwitterClientState,
  requestedAccountId?: unknown,
): string {
  return normalizeXAccountId(
    requestedAccountId ??
      state?.accountId ??
      resolveDefaultXAccountId(runtime, state),
  );
}

function readSetting(
  runtime: IAgentRuntime,
  state: TwitterClientState | undefined,
  key: keyof TwitterConfig,
): string | undefined {
  const fromState = state?.[key];
  return typeof fromState === "string" ? fromState : getSetting(runtime, key);
}

function parseAccountsJson(
  runtime: IAgentRuntime,
): Map<string, RawAccountRecord> {
  const raw =
    getSetting(runtime, "TWITTER_ACCOUNTS") ??
    getSetting(runtime, "X_ACCOUNTS");
  const accounts = new Map<string, RawAccountRecord>();
  if (!raw?.trim()) {
    return accounts;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const record = item as RawAccountRecord;
        const id = nonEmptyString(record.accountId ?? record.id);
        if (id) accounts.set(id, record);
      }
      return accounts;
    }

    if (parsed && typeof parsed === "object") {
      for (const [id, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (value && typeof value === "object") {
          accounts.set(id, value as RawAccountRecord);
        }
      }
    }
  } catch {
    return accounts;
  }

  return accounts;
}

function readRawField(
  record: RawAccountRecord | undefined,
  keys: string[],
): string | undefined {
  if (!record) return undefined;

  const credentials =
    record.credentials && typeof record.credentials === "object"
      ? (record.credentials as RawAccountRecord)
      : {};
  const settings =
    record.settings && typeof record.settings === "object"
      ? (record.settings as RawAccountRecord)
      : {};

  for (const source of [record, credentials, settings]) {
    for (const key of keys) {
      const value = source[key];
      const str = nonEmptyString(value);
      if (str) return str;
    }
  }

  return undefined;
}

async function readRuntimeAccountRecord(
  runtime: IAgentRuntime,
  accountId: string,
): Promise<XConnectorAccountRecord | null> {
  const accountRuntime = runtime as IAgentRuntime &
    RuntimeWithXConnectorAccounts;

  try {
    const store = accountRuntime.getConnectorAccountStore?.("x");
    const account = await store?.getAccount(accountId);
    if (account) return account;
  } catch {
    return null;
  }

  try {
    return (
      (await accountRuntime.getConnectorAccount?.({
        source: "x",
        accountId,
      })) ?? null
    );
  } catch {
    return null;
  }
}

function buildStateFromRecord(
  accountId: string,
  record?: RawAccountRecord,
): TwitterClientState {
  const authMode = readRawField(record, [
    "TWITTER_AUTH_MODE",
    "authMode",
    "mode",
  ]);

  return {
    accountId,
    TWITTER_ACCOUNT_ID: accountId,
    TWITTER_AUTH_MODE:
      authMode === "oauth" || authMode === "env" ? authMode : undefined,
    TWITTER_API_KEY: readRawField(record, ["TWITTER_API_KEY", "apiKey"]),
    TWITTER_API_SECRET_KEY: readRawField(record, [
      "TWITTER_API_SECRET_KEY",
      "apiSecretKey",
      "apiSecret",
      "consumerSecret",
    ]),
    TWITTER_ACCESS_TOKEN: readRawField(record, [
      "TWITTER_ACCESS_TOKEN",
      "accessToken",
    ]),
    TWITTER_ACCESS_TOKEN_SECRET: readRawField(record, [
      "TWITTER_ACCESS_TOKEN_SECRET",
      "accessTokenSecret",
      "accessSecret",
    ]),
    TWITTER_CLIENT_ID: readRawField(record, ["TWITTER_CLIENT_ID", "clientId"]),
    TWITTER_REDIRECT_URI: readRawField(record, [
      "TWITTER_REDIRECT_URI",
      "redirectUri",
    ]),
    TWITTER_SCOPES: readRawField(record, ["TWITTER_SCOPES", "scopes"]),
  };
}

function buildDefaultState(
  runtime: IAgentRuntime,
  state: TwitterClientState | undefined,
  accountId: string,
): TwitterClientState {
  const authMode =
    state?.TWITTER_AUTH_MODE ??
    readSetting(runtime, state, "TWITTER_AUTH_MODE");
  return {
    ...state,
    accountId,
    TWITTER_ACCOUNT_ID: accountId,
    TWITTER_AUTH_MODE:
      authMode === "env" || authMode === "oauth" ? authMode : undefined,
    TWITTER_API_KEY:
      state?.TWITTER_API_KEY ?? readSetting(runtime, state, "TWITTER_API_KEY"),
    TWITTER_API_SECRET_KEY:
      state?.TWITTER_API_SECRET_KEY ??
      readSetting(runtime, state, "TWITTER_API_SECRET_KEY"),
    TWITTER_ACCESS_TOKEN:
      state?.TWITTER_ACCESS_TOKEN ??
      readSetting(runtime, state, "TWITTER_ACCESS_TOKEN"),
    TWITTER_ACCESS_TOKEN_SECRET:
      state?.TWITTER_ACCESS_TOKEN_SECRET ??
      readSetting(runtime, state, "TWITTER_ACCESS_TOKEN_SECRET"),
    TWITTER_CLIENT_ID:
      state?.TWITTER_CLIENT_ID ??
      readSetting(runtime, state, "TWITTER_CLIENT_ID"),
    TWITTER_REDIRECT_URI:
      state?.TWITTER_REDIRECT_URI ??
      readSetting(runtime, state, "TWITTER_REDIRECT_URI"),
    TWITTER_SCOPES:
      state?.TWITTER_SCOPES ?? readSetting(runtime, state, "TWITTER_SCOPES"),
  };
}

export async function resolveTwitterAccountConfig(
  runtime: IAgentRuntime,
  options: {
    accountId?: unknown;
    state?: TwitterClientState;
  } = {},
): Promise<TwitterClientState> {
  const defaultAccountId = resolveDefaultXAccountId(runtime, options.state);
  const accountId = resolveRequestedXAccountId(
    runtime,
    options.state,
    options.accountId,
  );

  const runtimeRecord = await readRuntimeAccountRecord(runtime, accountId);
  const jsonRecord = parseAccountsJson(runtime).get(accountId);
  const record = runtimeRecord ?? jsonRecord;
  if (record) {
    return {
      ...options.state,
      ...buildStateFromRecord(accountId, record as unknown as RawAccountRecord),
    };
  }

  if (accountId === defaultAccountId) {
    return buildDefaultState(runtime, options.state, accountId);
  }

  return {
    ...options.state,
    accountId,
    TWITTER_ACCOUNT_ID: accountId,
    TWITTER_AUTH_MODE: options.state?.TWITTER_AUTH_MODE,
    TWITTER_API_KEY: options.state?.TWITTER_API_KEY ?? "",
    TWITTER_API_SECRET_KEY: options.state?.TWITTER_API_SECRET_KEY ?? "",
    TWITTER_ACCESS_TOKEN: options.state?.TWITTER_ACCESS_TOKEN ?? "",
    TWITTER_ACCESS_TOKEN_SECRET:
      options.state?.TWITTER_ACCESS_TOKEN_SECRET ?? "",
    TWITTER_CLIENT_ID: options.state?.TWITTER_CLIENT_ID ?? "",
    TWITTER_REDIRECT_URI: options.state?.TWITTER_REDIRECT_URI ?? "",
    TWITTER_SCOPES: options.state?.TWITTER_SCOPES,
  };
}
