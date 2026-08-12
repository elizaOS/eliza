/**
 * Environment variable keys that must never be written through user-editable
 * config or synced from config into process.env.
 *
 * The code-injection / TLS-hijack / path-resolution keys are imported from the
 * core spawn-env policy so the two denylists cannot drift: every key the spawn
 * sanitizer strips must also be blocked at the config-write boundary. Agent-
 * specific secrets (tokens, private keys, DB URLs) are appended on top.
 */
import {
  BLOCKED_SPAWN_ENV_KEYS,
  BLOCKED_SPAWN_ENV_PREFIXES,
} from "@elizaos/core";

export const BLOCKED_ENV_KEYS = new Set<string>([
  ...BLOCKED_SPAWN_ENV_KEYS,
  // Agent-specific step-up secrets and private keys (not spawn injection
  // primitives — they belong here so config writes cannot persist them).
  "ELIZA_API_TOKEN",
  "ELIZA_WALLET_EXPORT_TOKEN",
  "ELIZA_TERMINAL_RUN_TOKEN",
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
  "ELIZA_CLOUD_CLIENT_ADDRESS_KEY",
  "OPINION_PRIVATE_KEY",
  "OPINION_API_KEY",
  "GITHUB_TOKEN",
  "DATABASE_URL",
  "POSTGRES_URL",
]);

/**
 * Check whether an env key is blocked at the config-write boundary.
 *
 * Uses the same predicate as the spawn sanitizer (exact match + prefix match)
 * so indexed families like {@code GIT_CONFIG_KEY_0} are caught at config write
 * time, not just at the later spawn boundary.
 */
export function isBlockedEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (BLOCKED_ENV_KEYS.has(upper)) return true;
  return BLOCKED_SPAWN_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
