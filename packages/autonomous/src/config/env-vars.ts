import type { MiladyConfig } from "./types";

/**
 * Environment variable keys that must NEVER be synced from config → process.env.
 *
 * Mirrors the BLOCKED_ENV_KEYS set in server.ts.  This is a defense-in-depth
 * gate: even if a blocked key is somehow persisted into milady.config.json
 * (e.g. via an API bypass or manual file edit), it will not be loaded into the
 * process environment on startup.
 *
 * Categories:
 *   - Process-level code injection (NODE_OPTIONS, LD_PRELOAD, …)
 *   - TLS / proxy hijack (NODE_TLS_REJECT_UNAUTHORIZED, HTTP_PROXY, …)
 *   - Module resolution (NODE_PATH)
 *   - Privilege escalation tokens (MILADY_API_TOKEN, …)
 *   - Wallet private keys
 *   - System paths
 */
const BLOCKED_STARTUP_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "ELECTRON_RUN_AS_NODE",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_PATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "PATH",
  "HOME",
  "SHELL",
  "MILADY_API_TOKEN",
  "MILADY_WALLET_EXPORT_TOKEN",
  "MILADY_TERMINAL_RUN_TOKEN",
  "HYPERSCAPE_AUTH_TOKEN",
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "GITHUB_TOKEN",
  "DATABASE_URL",
  "POSTGRES_URL",
]);

export function collectConfigEnvVars(
  cfg?: MiladyConfig,
): Record<string, string> {
  const envConfig = cfg?.env;
  if (!envConfig) {
    return {};
  }

  const entries: Record<string, string> = {};

  if (envConfig.vars) {
    for (const [key, value] of Object.entries(envConfig.vars)) {
      if (!value) {
        continue;
      }
      if (BLOCKED_STARTUP_ENV_KEYS.has(key.toUpperCase())) {
        continue;
      }
      entries[key] = value;
    }
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (key === "shellEnv" || key === "vars") {
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    if (BLOCKED_STARTUP_ENV_KEYS.has(key.toUpperCase())) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}
