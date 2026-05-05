/**
 * Per-app ↔ Eliza environment variable aliasing.
 *
 * Lives in apps/app, NOT in packages/app-core. The alias table is passed to
 * the boot config so app-core's generic syncBrandEnvToEliza/syncElizaEnvToBrand
 * helpers can walk it.
 *
 * `buildBrandEnvAliases("MYAPP")` produces `MYAPP_PORT ↔ ELIZA_PORT`,
 * `MYAPP_API_TOKEN ↔ ELIZA_API_TOKEN`, etc. The prefix is sourced from
 * `APP_CONFIG.envPrefix` (or `cliName` as fallback).
 */
import { APP_CONFIG } from "./app-config";

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

function normalizeEnvPrefix(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!normalized) {
    throw new Error("App envPrefix must resolve to a non-empty identifier");
  }
  return normalized;
}

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

/** Convenience export consumed by main.tsx boot config. */
export const APP_ENV_ALIASES = buildBrandEnvAliases(APP_ENV_PREFIX);

/**
 * Backwards-compatible alias for the previous flat constant name. Older
 * imports referenced `ELIZA_ENV_ALIASES`; new code should use
 * `APP_ENV_ALIASES` (prefix-aware).
 */
export const ELIZA_ENV_ALIASES = APP_ENV_ALIASES;
