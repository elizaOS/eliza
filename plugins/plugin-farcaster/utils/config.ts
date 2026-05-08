import { type IAgentRuntime, parseBooleanFromText } from "@elizaos/core";
import { z } from "zod";
import {
  DEFAULT_CAST_INTERVAL_MAX,
  DEFAULT_CAST_INTERVAL_MIN,
  DEFAULT_MAX_CAST_LENGTH,
  DEFAULT_POLL_INTERVAL,
  type FarcasterConfig,
  FarcasterConfigSchema,
} from "../types";

type ProcessEnvLike = Record<string, string | undefined>;
type RawFarcasterAccountConfig = Partial<FarcasterConfig> &
  Record<string, unknown> & {
    accountId?: string;
    id?: string;
  };
type FarcasterMultiAccountConfig = RawFarcasterAccountConfig & {
  accounts?: Record<string, RawFarcasterAccountConfig>;
};

export type ResolvedFarcasterConfig = FarcasterConfig & { accountId: string };
export const DEFAULT_FARCASTER_ACCOUNT_ID = "default";

function getProcessEnv(): ProcessEnvLike {
  if (typeof process === "undefined") {
    return {};
  }
  return process.env as ProcessEnvLike;
}

const env = getProcessEnv();

function safeParseInt(value: string | undefined | null, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : Math.max(1, parsed);
}

function stringSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function characterConfig(runtime: IAgentRuntime): FarcasterMultiAccountConfig {
  const settings = runtime.character?.settings as Record<string, unknown> | undefined;
  const raw = settings?.farcaster;
  return raw && typeof raw === "object" ? (raw as FarcasterMultiAccountConfig) : {};
}

function parseAccountsJson(runtime: IAgentRuntime): Record<string, RawFarcasterAccountConfig> {
  const raw = stringSetting(runtime, "FARCASTER_ACCOUNTS");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed
          .filter(
            (item): item is RawFarcasterAccountConfig => Boolean(item) && typeof item === "object"
          )
          .map((item) => [normalizeFarcasterAccountId(item.accountId ?? item.id), item])
      );
    }
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, RawFarcasterAccountConfig>)
      : {};
  } catch {
    return {};
  }
}

function allAccountConfigs(runtime: IAgentRuntime): Record<string, RawFarcasterAccountConfig> {
  return {
    ...(characterConfig(runtime).accounts ?? {}),
    ...parseAccountsJson(runtime),
  };
}

function accountConfig(runtime: IAgentRuntime, accountId: string): RawFarcasterAccountConfig {
  const accounts = allAccountConfigs(runtime);
  return accounts[accountId] ?? accounts[normalizeFarcasterAccountId(accountId)] ?? {};
}

function rawField(
  record: RawFarcasterAccountConfig | undefined,
  keys: string[]
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

export function normalizeFarcasterAccountId(accountId?: unknown): string {
  if (typeof accountId !== "string") return DEFAULT_FARCASTER_ACCOUNT_ID;
  const trimmed = accountId.trim();
  return trimmed || DEFAULT_FARCASTER_ACCOUNT_ID;
}

export function listFarcasterAccountIds(runtime: IAgentRuntime): string[] {
  const ids = new Set<string>();
  const config = characterConfig(runtime);
  if (
    stringSetting(runtime, "FARCASTER_FID") ||
    (config.FARCASTER_FID && config.FARCASTER_SIGNER_UUID)
  ) {
    ids.add(DEFAULT_FARCASTER_ACCOUNT_ID);
  }
  for (const id of Object.keys(allAccountConfigs(runtime))) {
    ids.add(normalizeFarcasterAccountId(id));
  }
  return Array.from(ids.size ? ids : new Set([DEFAULT_FARCASTER_ACCOUNT_ID])).sort((a, b) =>
    a.localeCompare(b)
  );
}

export function resolveDefaultFarcasterAccountId(runtime: IAgentRuntime): string {
  const requested =
    stringSetting(runtime, "FARCASTER_DEFAULT_ACCOUNT_ID") ??
    stringSetting(runtime, "FARCASTER_ACCOUNT_ID");
  if (requested) return normalizeFarcasterAccountId(requested);
  const ids = listFarcasterAccountIds(runtime);
  return ids.includes(DEFAULT_FARCASTER_ACCOUNT_ID) ? DEFAULT_FARCASTER_ACCOUNT_ID : ids[0];
}

export function readFarcasterAccountId(...sources: unknown[]): string | undefined {
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
    const farcaster =
      data.farcaster && typeof data.farcaster === "object"
        ? (data.farcaster as Record<string, unknown>)
        : {};
    const value =
      record.accountId ??
      parameters.accountId ??
      data.accountId ??
      farcaster.accountId ??
      metadata.accountId;
    if (typeof value === "string" && value.trim()) return normalizeFarcasterAccountId(value);
  }
  return undefined;
}

export function getFarcasterFid(runtime: IAgentRuntime, accountId?: string | null): number | null {
  const normalizedAccountId = normalizeFarcasterAccountId(
    accountId ?? resolveDefaultFarcasterAccountId(runtime)
  );
  const account = accountConfig(runtime, normalizedAccountId);
  const base = characterConfig(runtime);
  const allowEnv = normalizedAccountId === DEFAULT_FARCASTER_ACCOUNT_ID;
  const fidStr =
    rawField(account, ["FARCASTER_FID", "fid"]) ??
    rawField(base, ["FARCASTER_FID", "fid"]) ??
    (allowEnv ? stringSetting(runtime, "FARCASTER_FID") : undefined);
  if (!fidStr) return null;
  const fid = Number.parseInt(fidStr as string, 10);
  return Number.isNaN(fid) ? null : fid;
}

export function hasFarcasterEnabled(runtime: IAgentRuntime, accountId?: string | null): boolean {
  const normalizedAccountId = normalizeFarcasterAccountId(
    accountId ?? resolveDefaultFarcasterAccountId(runtime)
  );
  const account = accountConfig(runtime, normalizedAccountId);
  const base = characterConfig(runtime);
  const allowEnv = normalizedAccountId === DEFAULT_FARCASTER_ACCOUNT_ID;
  const fid = getFarcasterFid(runtime, normalizedAccountId);
  const signerUuid =
    rawField(account, ["FARCASTER_SIGNER_UUID", "signerUuid"]) ??
    rawField(base, ["FARCASTER_SIGNER_UUID", "signerUuid"]) ??
    (allowEnv ? stringSetting(runtime, "FARCASTER_SIGNER_UUID") : undefined);
  const apiKey =
    rawField(account, ["FARCASTER_NEYNAR_API_KEY", "neynarApiKey", "apiKey"]) ??
    rawField(base, ["FARCASTER_NEYNAR_API_KEY", "neynarApiKey", "apiKey"]) ??
    (allowEnv ? stringSetting(runtime, "FARCASTER_NEYNAR_API_KEY") : undefined);

  runtime.logger.debug(`[hasFarcasterEnabled] FID: ${fid ? "Found" : "Missing"}`);
  runtime.logger.debug(`[hasFarcasterEnabled] Signer UUID: ${signerUuid ? "Found" : "Missing"}`);
  runtime.logger.debug(`[hasFarcasterEnabled] API Key: ${apiKey ? "Found" : "Missing"}`);

  return !!(fid && signerUuid && apiKey);
}

export function validateFarcasterConfig(
  runtime: IAgentRuntime,
  accountId?: string | null
): ResolvedFarcasterConfig {
  const normalizedAccountId = normalizeFarcasterAccountId(
    accountId ?? resolveDefaultFarcasterAccountId(runtime)
  );
  const account = accountConfig(runtime, normalizedAccountId);
  const base = characterConfig(runtime);
  const allowEnv = normalizedAccountId === DEFAULT_FARCASTER_ACCOUNT_ID;
  const field = (keys: string[], envKey?: string): string | undefined =>
    rawField(account, keys) ??
    rawField(base, keys) ??
    (allowEnv && envKey ? stringSetting(runtime, envKey) : undefined);
  const fid = getFarcasterFid(runtime, normalizedAccountId);

  try {
    const farcasterConfig = {
      FARCASTER_DRY_RUN:
        field(["FARCASTER_DRY_RUN", "dryRun"], "FARCASTER_DRY_RUN") ||
        parseBooleanFromText(env.FARCASTER_DRY_RUN || "false"),

      FARCASTER_FID: fid ?? undefined,

      MAX_CAST_LENGTH: safeParseInt(
        field(["MAX_CAST_LENGTH", "maxCastLength"], "MAX_CAST_LENGTH"),
        DEFAULT_MAX_CAST_LENGTH
      ),

      FARCASTER_POLL_INTERVAL: safeParseInt(
        field(["FARCASTER_POLL_INTERVAL", "pollInterval"], "FARCASTER_POLL_INTERVAL"),
        DEFAULT_POLL_INTERVAL
      ),

      ENABLE_CAST:
        field(["ENABLE_CAST", "enableCast"], "ENABLE_CAST") ||
        parseBooleanFromText(env.ENABLE_CAST || "true"),

      CAST_INTERVAL_MIN: safeParseInt(
        field(["CAST_INTERVAL_MIN", "castIntervalMin"], "CAST_INTERVAL_MIN"),
        DEFAULT_CAST_INTERVAL_MIN
      ),

      CAST_INTERVAL_MAX: safeParseInt(
        field(["CAST_INTERVAL_MAX", "castIntervalMax"], "CAST_INTERVAL_MAX"),
        DEFAULT_CAST_INTERVAL_MAX
      ),

      ENABLE_ACTION_PROCESSING:
        field(["ENABLE_ACTION_PROCESSING", "enableActionProcessing"], "ENABLE_ACTION_PROCESSING") ||
        parseBooleanFromText(env.ENABLE_ACTION_PROCESSING || "false"),

      ACTION_INTERVAL: safeParseInt(
        field(["ACTION_INTERVAL", "actionInterval"], "ACTION_INTERVAL"),
        5
      ),

      CAST_IMMEDIATELY:
        field(["CAST_IMMEDIATELY", "castImmediately"], "CAST_IMMEDIATELY") ||
        parseBooleanFromText(env.CAST_IMMEDIATELY || "false"),

      MAX_ACTIONS_PROCESSING: safeParseInt(
        field(["MAX_ACTIONS_PROCESSING", "maxActionsProcessing"], "MAX_ACTIONS_PROCESSING"),
        1
      ),

      FARCASTER_SIGNER_UUID: field(
        ["FARCASTER_SIGNER_UUID", "signerUuid"],
        "FARCASTER_SIGNER_UUID"
      ),

      FARCASTER_NEYNAR_API_KEY: field(
        ["FARCASTER_NEYNAR_API_KEY", "neynarApiKey", "apiKey"],
        "FARCASTER_NEYNAR_API_KEY"
      ),

      FARCASTER_HUB_URL:
        field(["FARCASTER_HUB_URL", "hubUrl"], "FARCASTER_HUB_URL") || "hub.pinata.cloud",

      FARCASTER_MODE: field(["FARCASTER_MODE", "mode"], "FARCASTER_MODE") || "polling",
    };

    runtime.logger.debug(
      `[validateFarcasterConfig] Resolved FID: ${farcasterConfig.FARCASTER_FID}`
    );
    runtime.logger.debug(
      `[validateFarcasterConfig] Resolved Signer UUID: ${farcasterConfig.FARCASTER_SIGNER_UUID ? "Found" : "Missing"}`
    );
    runtime.logger.debug(
      `[validateFarcasterConfig] Resolved API Key: ${farcasterConfig.FARCASTER_NEYNAR_API_KEY ? "Found" : "Missing"}`
    );

    const config = FarcasterConfigSchema.parse(farcasterConfig);

    const isDryRun = config.FARCASTER_DRY_RUN;

    runtime.logger.info("Farcaster Client Configuration:");
    runtime.logger.info(`- FID: ${config.FARCASTER_FID}`);
    runtime.logger.info(`- Dry Run Mode: ${isDryRun ? "enabled" : "disabled"}`);
    runtime.logger.info(`- Enable Cast: ${config.ENABLE_CAST ? "enabled" : "disabled"}`);

    if (config.ENABLE_CAST) {
      runtime.logger.info(
        `- Cast Interval: ${config.CAST_INTERVAL_MIN}-${config.CAST_INTERVAL_MAX} minutes`
      );
      runtime.logger.info(
        `- Cast Immediately: ${config.CAST_IMMEDIATELY ? "enabled" : "disabled"}`
      );
    }
    runtime.logger.info(
      `- Action Processing: ${config.ENABLE_ACTION_PROCESSING ? "enabled" : "disabled"}`
    );
    runtime.logger.info(`- Action Interval: ${config.ACTION_INTERVAL} minutes`);

    if (isDryRun) {
      runtime.logger.info(
        "Farcaster client initialized in dry run mode - no actual casts should be posted"
      );
    }

    return { ...config, accountId: normalizedAccountId };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      throw new Error(`Farcaster configuration validation failed:\n${errorMessages}`);
    }
    throw error;
  }
}
