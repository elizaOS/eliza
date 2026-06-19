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
  "ELIZA_CLOUD_CLIENT_ADDRESS_KEY",
  // Auth / step-up tokens
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

const SENSITIVE_RESPONSE_KEY_RE =
  /password|secret|api.?key|private.?key|seed.?phrase|authorization|connection.?string|credential|(?<!max)tokens?$/i;

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.trim() ? "[REDACTED]" : "";
  if (typeof value === "number" || typeof value === "boolean")
    return "[REDACTED]";
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      redacted[key] = redactValue(child);
    }
    return redacted;
  }
  return "[REDACTED]";
}

function redactConfigDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactConfigDeep);
  if (typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      redacted[key] = SENSITIVE_RESPONSE_KEY_RE.test(key)
        ? redactValue(child)
        : redactConfigDeep(child);
    }
    return redacted;
  }
  return value;
}

/**
 * Strip sensitive env vars from a config object before it is sent in a GET
 * /api/config response. Returns a shallow-cloned config with a filtered env
 * block — the original object is never mutated.
 */
export function filterConfigEnvForResponse(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const redactedConfig = redactConfigDeep(config) as Record<string, unknown>;
  const env = redactedConfig.env;
  if (!env || typeof env !== "object" || Array.isArray(env))
    return redactedConfig;

  const filteredEnv: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (SENSITIVE_ENV_RESPONSE_KEYS.has(key.toUpperCase())) continue;
    filteredEnv[key] = value;
  }
  return { ...redactedConfig, env: filteredEnv };
}
