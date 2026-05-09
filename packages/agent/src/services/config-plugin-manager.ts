import type { ElizaConfig } from "../config/types.eliza.ts";
import type {
  EjectResult,
  InstalledPluginInfo,
  PluginInstallResult,
  PluginManagerLike,
  PluginUninstallResult,
  RegistryPluginInfo,
  RegistrySearchResult,
  ReinjectResult,
  SyncResult,
} from "./plugin-manager-types.ts";
import {
  getPluginInfo,
  refreshRegistry,
  searchPlugins,
} from "./registry-client.ts";

type ConfigGetter = () => ElizaConfig;

function listInstalledFromConfig(config: ElizaConfig): InstalledPluginInfo[] {
  const installs = config.plugins?.installs;
  if (!installs || typeof installs !== "object") {
    return [];
  }

  return Object.entries(installs).map(([name, record]) => ({
    name,
    version: record.version,
    installedAt: record.installedAt,
  }));
}

function runtimeRequiredError(operation: string): Error {
  return new Error(
    `${operation} requires a running agent runtime with the plugin manager service.`,
  );
}

export function createConfigPluginManager(
  getConfig: ConfigGetter,
): PluginManagerLike {
  return {
    async refreshRegistry(): Promise<Map<string, RegistryPluginInfo>> {
      return refreshRegistry();
    },

    async listInstalledPlugins(): Promise<InstalledPluginInfo[]> {
      return listInstalledFromConfig(getConfig());
    },

    async getRegistryPlugin(name: string): Promise<RegistryPluginInfo | null> {
      return getPluginInfo(name);
    },

    async searchRegistry(
      query: string,
      limit?: number,
    ): Promise<RegistrySearchResult[]> {
      return (await searchPlugins(query, limit)).map((result) => ({
        ...result,
        version: null,
        npmPackage: result.name,
      }));
    },

    async installPlugin(): Promise<PluginInstallResult> {
      throw runtimeRequiredError("Plugin installation");
    },

    async uninstallPlugin(): Promise<PluginUninstallResult> {
      throw runtimeRequiredError("Plugin removal");
    },

    async listEjectedPlugins(): Promise<InstalledPluginInfo[]> {
      return [];
    },

    async ejectPlugin(): Promise<EjectResult> {
      throw runtimeRequiredError("Plugin ejection");
    },

    async syncPlugin(): Promise<SyncResult> {
      throw runtimeRequiredError("Plugin sync");
    },

    async reinjectPlugin(): Promise<ReinjectResult> {
      throw runtimeRequiredError("Plugin reinjection");
    },
  };
}
