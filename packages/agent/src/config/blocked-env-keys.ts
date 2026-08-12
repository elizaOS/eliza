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
 * Families whose whole namespace is dangerous, so no exact-key list can cover
 * them. `BASH_FUNC_*` is the Shellshock function-export prefix; the
 * package-manager and container families redirect registries, install hooks,
 * and runtimes for anything spawned afterwards. The core spawn policy is the
 * single source: it guards a caller-supplied child environment, while this
 * boundary guards config and API writes, which reach `process.env` and are
 * then inherited by every spawn site that passes no explicit env — so both
 * paths need the same families.
 */
export const BLOCKED_ENV_KEY_PREFIXES: readonly string[] =
  BLOCKED_SPAWN_ENV_PREFIXES;

/**
 * The single predicate every config/API env gate should use. `BLOCKED_ENV_KEYS`
 * remains exported for callers that need the raw set, but membership alone
 * misses the prefix families above, and indexed families like
 * {@code GIT_CONFIG_KEY_0} are caught here at config write time, not just at
 * the later spawn boundary.
 */
export function isBlockedEnvKey(key: string): boolean {
  // Trim before matching: a surrounding-whitespace variant would otherwise slip
  // past both the exact set and the prefix scan. No real key carries it, and the
  // plugin route already normalises this way.
  const upper = key.trim().toUpperCase();
  if (upper.length === 0) {
    return false;
  }
  if (BLOCKED_ENV_KEYS.has(upper)) {
    return true;
  }
  return BLOCKED_ENV_KEY_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
