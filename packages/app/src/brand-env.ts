import { APP_CONFIG } from "./app-config";
import { normalizeEnvPrefix } from "./env-prefix.js";

const ENV_ALIAS_SUFFIXES = [
  // API & auth
  ["API_TOKEN", "API_TOKEN"],
  ["API_BIND", "API_BIND"],
  ["PAIRING_DISABLED", "PAIRING_DISABLED"],
  ["ALLOWED_ORIGINS", "ALLOWED_ORIGINS"],
  ["ALLOW_NULL_ORIGIN", "ALLOW_NULL_ORIGIN"],
  ["ALLOW_WS_QUERY_TOKEN", "ALLOW_WS_QUERY_TOKEN"],
  ["WALLET_EXPORT_TOKEN", "WALLET_EXPORT_TOKEN"],
  ["TERMINAL_RUN_TOKEN", "TERMINAL_RUN_TOKEN"],
  ["NAMESPACE", "NAMESPACE"],
  ["STATE_DIR", "STATE_DIR"],
  ["CONFIG_PATH", "CONFIG_PATH"],
  // Cloud services
  ["CLOUD_TTS_DISABLED", "CLOUD_TTS_DISABLED"],
  ["CLOUD_MEDIA_DISABLED", "CLOUD_MEDIA_DISABLED"],
  ["CLOUD_EMBEDDINGS_DISABLED", "CLOUD_EMBEDDINGS_DISABLED"],
  ["CLOUD_RPC_DISABLED", "CLOUD_RPC_DISABLED"],
  ["DISABLE_LOCAL_EMBEDDINGS", "DISABLE_LOCAL_EMBEDDINGS"],
  ["DISABLE_EDGE_TTS", "DISABLE_EDGE_TTS"],
  // Ports
  ["PORT", "PORT"],
  ["API_PORT", "API_PORT"],
  ["HOME_PORT", "HOME_PORT"],
  ["GATEWAY_PORT", "GATEWAY_PORT"],
  ["BRIDGE_PORT", "BRIDGE_PORT"],
] as const;

export function buildBrandEnvAliases(prefix: string) {
  const normalizedPrefix = normalizeEnvPrefix(prefix);
  return ENV_ALIAS_SUFFIXES.map(
    ([brandSuffix, elizaSuffix]) =>
      [`${normalizedPrefix}_${brandSuffix}`, `ELIZA_${elizaSuffix}`] as const,
  );
}

export const APP_ENV_PREFIX = normalizeEnvPrefix(
  APP_CONFIG.envPrefix ?? APP_CONFIG.cliName,
);

export const APP_ENV_ALIASES = buildBrandEnvAliases(APP_ENV_PREFIX);
