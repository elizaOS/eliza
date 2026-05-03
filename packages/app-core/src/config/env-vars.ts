import {
  collectConfigEnvVars as upstreamCollectConfigEnvVars,
  collectConnectorEnvVars as upstreamCollectConnectorEnvVars,
  CONNECTOR_ENV_MAP as upstreamConnectorEnvMap,
} from "@elizaos/agent";

const COMPAT_BLOCKED_STARTUP_ENV_KEYS = new Set([
  "ELIZA_API_TOKEN",
  "ELIZA_WALLET_EXPORT_TOKEN",
  "ELIZA_TERMINAL_RUN_TOKEN",
]);
const TELEGRAM_ACCOUNT_ENV_MAP = {
  phone: "TELEGRAM_ACCOUNT_PHONE",
  appId: "TELEGRAM_ACCOUNT_APP_ID",
  appHash: "TELEGRAM_ACCOUNT_APP_HASH",
  deviceModel: "TELEGRAM_ACCOUNT_DEVICE_MODEL",
  systemVersion: "TELEGRAM_ACCOUNT_SYSTEM_VERSION",
} as const;

export const CONNECTOR_ENV_MAP = {
  ...upstreamConnectorEnvMap,
  telegramAccount:
    upstreamConnectorEnvMap.telegramAccount ?? TELEGRAM_ACCOUNT_ENV_MAP,
};

export function collectConfigEnvVars(
  ...args: Parameters<typeof upstreamCollectConfigEnvVars>
): ReturnType<typeof upstreamCollectConfigEnvVars> {
  const entries = upstreamCollectConfigEnvVars(...args);

  for (const key of Object.keys(entries)) {
    if (COMPAT_BLOCKED_STARTUP_ENV_KEYS.has(key.toUpperCase())) {
      delete entries[key];
    }
  }

  return entries;
}

export function collectConnectorEnvVars(
  ...args: Parameters<typeof upstreamCollectConnectorEnvVars>
): ReturnType<typeof upstreamCollectConnectorEnvVars> {
  const entries = upstreamCollectConnectorEnvVars(...args);
  const [cfg] = args;
  const rawConnectors =
    cfg?.connectors ?? (cfg as Record<string, unknown> | undefined)?.channels;
  const telegramAccount =
    rawConnectors &&
    typeof rawConnectors === "object" &&
    !Array.isArray(rawConnectors)
      ? (rawConnectors as Record<string, unknown>).telegramAccount
      : undefined;

  if (
    telegramAccount &&
    typeof telegramAccount === "object" &&
    !Array.isArray(telegramAccount)
  ) {
    const config = telegramAccount as Record<string, unknown>;
    for (const [field, envKey] of Object.entries(TELEGRAM_ACCOUNT_ENV_MAP)) {
      const value = config[field];
      if (typeof value === "string" && value.trim()) {
        entries[envKey] = value;
      }
    }
  }

  return entries;
}
