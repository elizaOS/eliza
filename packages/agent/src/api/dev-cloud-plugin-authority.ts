import {
  DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEYS,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";

const CLOUD_AUTHORITY_PREFIXES = [
  "ELIZAOS_CLOUD_",
  "ELIZA_CLOUD_",
  "ELIZA_DEV_CLOUD_",
  "ELIZACLOUD_",
  "WAIFU_ELIZA_CLOUD_",
] as const;

const STEWARD_AUTHORITY_KEYS = new Set<string>(
  DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEYS,
);

type PluginParameterKey = { key: string };

/** Launcher-owned Cloud and Steward settings cannot be rewritten through plugin config. */
export function isLauncherOwnedCloudPluginKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  return (
    STEWARD_AUTHORITY_KEYS.has(normalized) ||
    CLOUD_AUTHORITY_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

/**
 * Return an actionable rejection before a plugin mutation can touch process,
 * runtime, or persisted config state. Enabling/disabling a plugin is included:
 * that path restores or clears its saved parameters through the runtime bridge.
 */
export function devCloudPluginMutationRejection(
  parameters: readonly PluginParameterKey[],
  body: { config?: unknown; enabled?: unknown },
): string | null {
  if (!resolveDevCloudEnvAuthority()) return null;

  const ownedParameterKeys = new Set(
    parameters
      .map((parameter) => parameter.key)
      .filter(isLauncherOwnedCloudPluginKey),
  );
  if (ownedParameterKeys.size === 0) return null;

  const touched = new Set<string>();
  if (typeof body.enabled === "boolean") {
    for (const key of ownedParameterKeys) touched.add(key);
  }
  if (
    body.config &&
    typeof body.config === "object" &&
    !Array.isArray(body.config)
  ) {
    for (const key of Object.keys(body.config)) {
      if (ownedParameterKeys.has(key)) touched.add(key);
    }
  }
  if (touched.size === 0) return null;

  return `Plugin settings cannot modify launcher-owned Cloud parameters while the local development Cloud target is active: ${[...touched].sort().join(", ")}`;
}
