// CYCLE BREAK: re-exporting from @elizaos/agent here created an
// agent ↔ shared cycle that broke node ESM resolution at the bench
// server boot. Consumers should import these directly from
// `@elizaos/agent` instead. Type-only forwarder kept so existing
// `import type { ElizaConfig } from "@elizaos/shared"` still resolves.
export type { ElizaConfig } from "@elizaos/agent";

export interface LegacyCloudConfig {
  cloud?: { enabled?: boolean } | null;
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
  const cloudEnabled = config?.cloud?.enabled === true;
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
