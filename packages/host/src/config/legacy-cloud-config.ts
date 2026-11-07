/**
 * Backward-compatibility shims for elizaOS cloud configuration: re-exports the
 * `ElizaConfig` type and provides the legacy "cloud.enabled" → `providers[]`
 * migration helpers. `migrateCloudEnabledToProviders` upgrades an old config
 * that set `cloud.enabled` into the modern representation (an "elizacloud"
 * entry in `providers`); `isCloudActiveFromProviders` reports whether that
 * entry is present.
 */
export interface LegacyCloudConfig {
  cloud?: {
    enabled?: boolean;
  } | null;
  providers?: string[];
  [key: string]: unknown;
}
export function isCloudActiveFromProviders(
  providers: string[] | undefined | null,
): boolean {
  if (!Array.isArray(providers) || providers.length === 0) {
    return false;
  }
  return providers.includes("elizacloud");
}
export function migrateCloudEnabledToProviders(
  config: LegacyCloudConfig,
): LegacyCloudConfig {
  const cloudEnabled = config.cloud?.enabled === true;
  if (!cloudEnabled) {
    return config;
  }
  const existingProviders = Array.isArray(config.providers)
    ? config.providers
    : [];
  if (existingProviders.includes("elizacloud")) {
    return config;
  }
  return {
    ...config,
    providers: [...existingProviders, "elizacloud"],
  };
}
