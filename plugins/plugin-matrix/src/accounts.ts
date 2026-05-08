import type { IAgentRuntime } from "@elizaos/core";
import type { MatrixSettings } from "./types.js";

export const DEFAULT_MATRIX_ACCOUNT_ID = "default";

export type MatrixAccountConfig = Partial<
  Omit<MatrixSettings, "rooms" | "accountId">
> & {
  accountId?: string;
  id?: string;
  rooms?: string[] | string;
};

type MatrixMultiAccountConfig = MatrixAccountConfig & {
  accounts?: Record<string, MatrixAccountConfig>;
};

function stringSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function characterConfig(runtime: IAgentRuntime): MatrixMultiAccountConfig {
  const settings = runtime.character?.settings as Record<string, unknown> | undefined;
  const raw = settings?.matrix;
  return raw && typeof raw === "object" ? (raw as MatrixMultiAccountConfig) : {};
}

function parseAccountsJson(runtime: IAgentRuntime): Record<string, MatrixAccountConfig> {
  const raw = stringSetting(runtime, "MATRIX_ACCOUNTS");
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed
          .filter((item): item is MatrixAccountConfig => Boolean(item) && typeof item === "object")
          .map((item) => [normalizeMatrixAccountId(item.accountId ?? item.id), item])
      );
    }
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, MatrixAccountConfig>)
      : {};
  } catch {
    return {};
  }
}

function allAccountConfigs(runtime: IAgentRuntime): Record<string, MatrixAccountConfig> {
  return {
    ...(characterConfig(runtime).accounts ?? {}),
    ...parseAccountsJson(runtime),
  };
}

function accountConfig(runtime: IAgentRuntime, accountId: string): MatrixAccountConfig {
  const accounts = allAccountConfigs(runtime);
  return accounts[accountId] ?? accounts[normalizeMatrixAccountId(accountId)] ?? {};
}

function boolValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return fallback;
}

function roomsValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((room) => String(room).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((room) => room.trim())
      .filter(Boolean);
  }
  return [];
}

export function normalizeMatrixAccountId(accountId?: unknown): string {
  if (typeof accountId !== "string") return DEFAULT_MATRIX_ACCOUNT_ID;
  const trimmed = accountId.trim();
  return trimmed || DEFAULT_MATRIX_ACCOUNT_ID;
}

export function listMatrixAccountIds(runtime: IAgentRuntime): string[] {
  const ids = new Set<string>();
  const config = characterConfig(runtime);

  if (
    stringSetting(runtime, "MATRIX_ACCESS_TOKEN") ||
    (config.homeserver && config.userId && config.accessToken)
  ) {
    ids.add(DEFAULT_MATRIX_ACCOUNT_ID);
  }

  for (const id of Object.keys(allAccountConfigs(runtime))) {
    ids.add(normalizeMatrixAccountId(id));
  }

  return Array.from(ids.size ? ids : new Set([DEFAULT_MATRIX_ACCOUNT_ID])).sort((a, b) =>
    a.localeCompare(b)
  );
}

export function resolveDefaultMatrixAccountId(runtime: IAgentRuntime): string {
  const requested =
    stringSetting(runtime, "MATRIX_DEFAULT_ACCOUNT_ID") ?? stringSetting(runtime, "MATRIX_ACCOUNT_ID");
  if (requested) return normalizeMatrixAccountId(requested);

  const ids = listMatrixAccountIds(runtime);
  return ids.includes(DEFAULT_MATRIX_ACCOUNT_ID) ? DEFAULT_MATRIX_ACCOUNT_ID : ids[0];
}

export function readMatrixAccountId(...sources: unknown[]): string | undefined {
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
    const matrix =
      data.matrix && typeof data.matrix === "object" ? (data.matrix as Record<string, unknown>) : {};
    const value =
      record.accountId ?? parameters.accountId ?? data.accountId ?? matrix.accountId ?? metadata.accountId;
    if (typeof value === "string" && value.trim()) return normalizeMatrixAccountId(value);
  }
  return undefined;
}

export function resolveMatrixAccountSettings(
  runtime: IAgentRuntime,
  requestedAccountId?: string | null
): MatrixSettings {
  const accountId = normalizeMatrixAccountId(
    requestedAccountId ?? resolveDefaultMatrixAccountId(runtime)
  );
  const base = characterConfig(runtime);
  const account = accountConfig(runtime, accountId);
  const allowEnv = accountId === DEFAULT_MATRIX_ACCOUNT_ID;

  return {
    accountId,
    homeserver: account.homeserver ?? base.homeserver ?? (allowEnv ? stringSetting(runtime, "MATRIX_HOMESERVER") : undefined) ?? "",
    userId: account.userId ?? base.userId ?? (allowEnv ? stringSetting(runtime, "MATRIX_USER_ID") : undefined) ?? "",
    accessToken:
      account.accessToken ??
      base.accessToken ??
      (allowEnv ? stringSetting(runtime, "MATRIX_ACCESS_TOKEN") : undefined) ??
      "",
    deviceId:
      account.deviceId ?? base.deviceId ?? (allowEnv ? stringSetting(runtime, "MATRIX_DEVICE_ID") : undefined),
    rooms: roomsValue(account.rooms ?? base.rooms ?? (allowEnv ? stringSetting(runtime, "MATRIX_ROOMS") : undefined)),
    autoJoin: boolValue(
      account.autoJoin ?? base.autoJoin ?? (allowEnv ? stringSetting(runtime, "MATRIX_AUTO_JOIN") : undefined)
    ),
    encryption: boolValue(
      account.encryption ?? base.encryption ?? (allowEnv ? stringSetting(runtime, "MATRIX_ENCRYPTION") : undefined)
    ),
    requireMention: boolValue(
      account.requireMention ??
        base.requireMention ??
        (allowEnv ? stringSetting(runtime, "MATRIX_REQUIRE_MENTION") : undefined)
    ),
    enabled: boolValue(account.enabled ?? base.enabled, true),
  };
}
