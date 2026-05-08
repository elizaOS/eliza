import type { IAgentRuntime } from "@elizaos/core";
import { DEFAULT_NOSTR_RELAYS, type NostrDmPolicy, type NostrSettings } from "./types.js";

export const DEFAULT_NOSTR_ACCOUNT_ID = "default";

export type NostrAccountConfig = Partial<
  Omit<NostrSettings, "relays" | "allowFrom" | "publicKey" | "accountId">
> & {
  accountId?: string;
  id?: string;
  relays?: string[] | string;
  allowFrom?: string[] | string;
};

type NostrMultiAccountConfig = NostrAccountConfig & {
  accounts?: Record<string, NostrAccountConfig>;
};

function stringSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  if (typeof value === "string" && value.trim()) return value.trim();
  return process.env[key];
}

function characterConfig(runtime: IAgentRuntime): NostrMultiAccountConfig {
  const settings = runtime.character?.settings as Record<string, unknown> | undefined;
  const raw = settings?.nostr;
  return raw && typeof raw === "object" ? (raw as NostrMultiAccountConfig) : {};
}

function parseAccountsJson(runtime: IAgentRuntime): Record<string, NostrAccountConfig> {
  const raw = stringSetting(runtime, "NOSTR_ACCOUNTS");
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed
          .filter((item): item is NostrAccountConfig => Boolean(item) && typeof item === "object")
          .map((item) => [normalizeNostrAccountId(item.accountId ?? item.id), item])
      );
    }
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, NostrAccountConfig>)
      : {};
  } catch {
    return {};
  }
}

function allAccountConfigs(runtime: IAgentRuntime): Record<string, NostrAccountConfig> {
  return {
    ...(characterConfig(runtime).accounts ?? {}),
    ...parseAccountsJson(runtime),
  };
}

function accountConfig(runtime: IAgentRuntime, accountId: string): NostrAccountConfig {
  const accounts = allAccountConfigs(runtime);
  return accounts[accountId] ?? accounts[normalizeNostrAccountId(accountId)] ?? {};
}

function boolValue(value: unknown, fallback = true): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() !== "false";
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

export function normalizeNostrAccountId(accountId?: unknown): string {
  if (typeof accountId !== "string") return DEFAULT_NOSTR_ACCOUNT_ID;
  const trimmed = accountId.trim();
  return trimmed || DEFAULT_NOSTR_ACCOUNT_ID;
}

export function listNostrAccountIds(runtime: IAgentRuntime): string[] {
  const ids = new Set<string>();
  const config = characterConfig(runtime);

  if (stringSetting(runtime, "NOSTR_PRIVATE_KEY") || config.privateKey) {
    ids.add(DEFAULT_NOSTR_ACCOUNT_ID);
  }

  for (const id of Object.keys(allAccountConfigs(runtime))) {
    ids.add(normalizeNostrAccountId(id));
  }

  return Array.from(ids.size ? ids : new Set([DEFAULT_NOSTR_ACCOUNT_ID])).sort((a, b) =>
    a.localeCompare(b)
  );
}

export function resolveDefaultNostrAccountId(runtime: IAgentRuntime): string {
  const requested =
    stringSetting(runtime, "NOSTR_DEFAULT_ACCOUNT_ID") ??
    stringSetting(runtime, "NOSTR_ACCOUNT_ID");
  if (requested) return normalizeNostrAccountId(requested);

  const ids = listNostrAccountIds(runtime);
  return ids.includes(DEFAULT_NOSTR_ACCOUNT_ID) ? DEFAULT_NOSTR_ACCOUNT_ID : ids[0];
}

export function readNostrAccountId(...sources: unknown[]): string | undefined {
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
    const nostr =
      data.nostr && typeof data.nostr === "object" ? (data.nostr as Record<string, unknown>) : {};
    const value =
      record.accountId ??
      parameters.accountId ??
      data.accountId ??
      nostr.accountId ??
      metadata.accountId;
    if (typeof value === "string" && value.trim()) return normalizeNostrAccountId(value);
  }
  return undefined;
}

export function resolveNostrAccountSettings(
  runtime: IAgentRuntime,
  requestedAccountId?: string | null
): NostrSettings {
  const accountId = normalizeNostrAccountId(
    requestedAccountId ?? resolveDefaultNostrAccountId(runtime)
  );
  const base = characterConfig(runtime);
  const account = accountConfig(runtime, accountId);
  const allowEnv = accountId === DEFAULT_NOSTR_ACCOUNT_ID;
  const relays = stringList(
    account.relays ?? base.relays ?? (allowEnv ? stringSetting(runtime, "NOSTR_RELAYS") : undefined)
  );
  const allowFrom = stringList(
    account.allowFrom ??
      base.allowFrom ??
      (allowEnv ? stringSetting(runtime, "NOSTR_ALLOW_FROM") : undefined)
  );

  return {
    accountId,
    privateKey:
      account.privateKey ??
      base.privateKey ??
      (allowEnv ? stringSetting(runtime, "NOSTR_PRIVATE_KEY") : undefined) ??
      "",
    publicKey: "",
    relays: relays.length ? relays : DEFAULT_NOSTR_RELAYS,
    dmPolicy: (account.dmPolicy ??
      base.dmPolicy ??
      (allowEnv ? stringSetting(runtime, "NOSTR_DM_POLICY") : undefined) ??
      "pairing") as NostrDmPolicy,
    allowFrom,
    profile: account.profile ?? base.profile,
    enabled: boolValue(
      account.enabled ??
        base.enabled ??
        (allowEnv ? stringSetting(runtime, "NOSTR_ENABLED") : undefined)
    ),
  };
}
