/**
 * Platform-reserved environment-variable keys for managed container deploys
 * (dedicated agents AND Apps/Product-2 app containers).
 *
 * The platform injects/owns these — the managed Postgres DSN, the cloud API
 * token, the metered-identity / cloud-agent keys. A caller's `environmentVars`
 * must never set them: on the deploy path a caller-supplied value could shadow
 * the platform-injected DB DSN or pre-empt a managed identity/token key. This is
 * the single source of truth for that denylist, shared by the agent path
 * (`managed-eliza-config`) and the app-deploy path (`app-deploy-orchestrator`).
 *
 * Intentionally dependency-free so both (deliberately pure, fake-tested) modules
 * can import it without pulling in the DB / cloud-binding import graph.
 */

export const RESERVED_PLATFORM_ENV_KEYS = [
  "DATABASE_URL",
  "ELIZA_MANAGED_DATABASE_URL",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_CLOUD_AGENT_ID",
  "PUBLIC_BASE_URL",
  "STEWARD_API_URL",
  "STEWARD_INVOKE_URL",
  "STEWARD_CAPABILITIES",
  "STEWARD_CAP_OPENAI_CHAT",
  "STEWARD_KEYLESS_MODE",
  "STEWARD_KEYLESS_SERVICES",
  "STEWARD_AGENT_ID",
  "STEWARD_AGENT_TOKEN",
  "STEWARD_JWT",
  "STEWARD_JWT_FILE",
  "STEWARD_REFRESH_URL",
  "STEWARD_REFRESH_SERVICE_TOKEN",
  "WAIFU_ELIZA_CLOUD_AGENT_ID",
] as const;

function toUpperSet(keys: Iterable<string>): Set<string> {
  const set = new Set<string>();
  for (const key of keys) set.add(key.toUpperCase());
  return set;
}

/**
 * Case-insensitive: the caller-supplied keys that collide with a reserved key.
 * Returns the original (caller-cased) keys so an error can echo them back.
 */
export function findReservedEnvKeys(
  keys: Iterable<string>,
  reserved: Iterable<string> = RESERVED_PLATFORM_ENV_KEYS,
): string[] {
  const reservedSet = toUpperSet(reserved);
  const hits: string[] = [];
  for (const key of keys) {
    if (reservedSet.has(key.toUpperCase())) hits.push(key);
  }
  return hits;
}

/**
 * Case-insensitive: a copy of `env` with every reserved key removed. Used on the
 * deploy path to strip caller-supplied reserved keys before the platform injects
 * its own managed values.
 */
export function stripReservedEnvKeys(
  env: Record<string, string>,
  reserved: Iterable<string> = RESERVED_PLATFORM_ENV_KEYS,
): Record<string, string> {
  const reservedSet = toUpperSet(reserved);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !reservedSet.has(key.toUpperCase())),
  );
}
