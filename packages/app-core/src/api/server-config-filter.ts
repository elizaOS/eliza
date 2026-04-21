/** Config/env filtering — strip sensitive keys from API responses. */

/**
 * Env keys that must never be returned in GET /api/config responses.
 * Covers private keys, auth tokens, and database credentials.
 * Keys are stored and matched case-insensitively (uppercased).
 */
export const SENSITIVE_ENV_RESPONSE_KEYS = new Set([
  // Wallet private keys
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "MILADY_CLOUD_CLIENT_ADDRESS_KEY",
  // Auth / step-up tokens
  "ELIZA_API_TOKEN",
  "ELIZA_API_TOKEN",
  "ELIZA_WALLET_EXPORT_TOKEN",
  "ELIZA_TERMINAL_RUN_TOKEN",
  "HYPERSCAPE_AUTH_TOKEN",
  // Cloud API keys
  "ELIZAOS_CLOUD_API_KEY",
  // Third-party auth tokens
  "GITHUB_TOKEN",
  // Database connection strings (may contain credentials)
  "DATABASE_URL",
  "POSTGRES_URL",
]);

/**
 * Strip sensitive env vars from a config object before it is sent in a GET
 * /api/config response. Returns a shallow-cloned config with a filtered env
 * block — the original object is never mutated.
 */
export function filterConfigEnvForResponse(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const env = config.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return config;

  const filteredEnv: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (SENSITIVE_ENV_RESPONSE_KEYS.has(key.toUpperCase())) continue;
    filteredEnv[key] = value;
  }
  return { ...config, env: filteredEnv };
}
