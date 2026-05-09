import type { ElizaConfig } from "../config/config.js";

export const ADVANCED_CAPABILITY_PLUGIN_IDS = [
  "experience",
  "todos",
  "personality",
] as const;

export type AdvancedCapabilityPluginId =
  (typeof ADVANCED_CAPABILITY_PLUGIN_IDS)[number];

function readCapabilityEntryEnabled(
  config: Pick<ElizaConfig, "plugins"> | null | undefined,
  pluginId: AdvancedCapabilityPluginId,
): boolean | null {
  const value = config?.plugins?.entries?.[pluginId]?.enabled;
  return typeof value === "boolean" ? value : null;
}

export function isAdvancedCapabilityPluginId(
  pluginId: string,
): pluginId is AdvancedCapabilityPluginId {
  return ADVANCED_CAPABILITY_PLUGIN_IDS.includes(
    pluginId as AdvancedCapabilityPluginId,
  );
}

export function resolveAdvancedCapabilitiesEnabled(
  config: Pick<ElizaConfig, "plugins"> | null | undefined,
): boolean {
  for (const pluginId of ADVANCED_CAPABILITY_PLUGIN_IDS) {
    const enabled = readCapabilityEntryEnabled(config, pluginId);
    if (enabled !== null) {
      return enabled;
    }
  }

  return true;
}

export function applyAdvancedCapabilitiesConfig(
  config: ElizaConfig,
  enabled: boolean,
): void {
  config.plugins = config.plugins ?? {};

  const pluginsRoot = config.plugins as Record<string, unknown>;
  const previousEntries =
    (pluginsRoot.entries as
      | Record<string, { enabled?: boolean; [key: string]: unknown }>
      | undefined) ?? {};
  const nextEntries = { ...previousEntries };

  for (const pluginId of ADVANCED_CAPABILITY_PLUGIN_IDS) {
    nextEntries[pluginId] = {
      ...previousEntries[pluginId],
      enabled,
    };
  }

  pluginsRoot.entries = nextEntries;
}

export function applyAdvancedCapabilitySettings(
  settings: Record<string, string>,
  enabled: boolean,
): Record<string, string> {
  return {
    ...settings,
    ADVANCED_CAPABILITIES: enabled ? "true" : "false",
    ENABLE_EXTENDED_CAPABILITIES: enabled ? "true" : "false",
  };
}
