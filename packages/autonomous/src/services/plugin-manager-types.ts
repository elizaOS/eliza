export interface RegistryVersionSupport {
  v0: boolean;
  v1: boolean;
  v2: boolean;
}

export interface RegistryPluginNpmInfo {
  package: string;
  v0Version?: string | null;
  v1Version?: string | null;
  v2Version?: string | null;
}

export interface RegistryPluginViewerInfo {
  url: string;
  embedParams?: Record<string, string>;
  postMessageAuth?: boolean;
  sandbox?: string;
}

export interface AppUiExtensionConfig {
  detailPanelId: string;
}

export interface RegistryPluginAppMeta {
  displayName?: string;
  category?: string;
  launchType?: string;
  launchUrl?: string | null;
  icon?: string | null;
  capabilities?: string[];
  uiExtension?: AppUiExtensionConfig;
  viewer?: RegistryPluginViewerInfo;
}

export interface RegistryPluginInfo {
  name: string;
  gitRepo: string;
  gitUrl: string;
  displayName?: string;
  description: string;
  homepage?: string | null;
  topics: string[];
  stars: number;
  language: string;
  launchType?: string;
  launchUrl?: string | null;
  viewer?: RegistryPluginViewerInfo;
  uiExtension?: AppUiExtensionConfig;
  kind?: string;
  appMeta?: RegistryPluginAppMeta;
  npm: RegistryPluginNpmInfo;
  supports: RegistryVersionSupport;
  // App-specific metadata
  category?: string;
  capabilities?: string[];
  icon?: string | null;
}

export interface RegistrySearchResult {
  name: string;
  description: string;
  score: number;
  tags: string[];
  version: string | null;
  latestVersion?: string | null;
  npmPackage: string;
  repository: string;
  stars: number;
  supports: RegistryVersionSupport;
}

export interface InstalledPluginInfo {
  name: string;
  version?: string;
  installedAt?: string;
}

export interface InstallProgressLike {
  phase: string;
  message: string;
  pluginName?: string;
}

export interface PluginInstallResult {
  success: boolean;
  pluginName: string;
  version: string;
  installPath: string;
  requiresRestart: boolean;
  error?: string;
}

export interface PluginUninstallResult {
  success: boolean;
  pluginName: string;
  requiresRestart: boolean;
  error?: string;
}

export interface EjectResult {
  success: boolean;
  pluginName: string;
  ejectedPath: string;
  requiresRestart: boolean;
  error?: string;
}

export interface SyncResult {
  success: boolean;
  pluginName: string;
  ejectedPath: string;
  requiresRestart: boolean;
  error?: string;
}

export interface ReinjectResult {
  success: boolean;
  pluginName: string;
  removedPath: string;
  requiresRestart: boolean;
  error?: string;
}

export interface PluginManagerLike {
  refreshRegistry(): Promise<Map<string, RegistryPluginInfo>>;
  listInstalledPlugins(): Promise<InstalledPluginInfo[]>;
  getRegistryPlugin(name: string): Promise<RegistryPluginInfo | null>;
  searchRegistry(
    query: string,
    limit?: number,
  ): Promise<RegistrySearchResult[]>;
  installPlugin(
    pluginName: string,
    onProgress?: (progress: InstallProgressLike) => void,
  ): Promise<PluginInstallResult>;
  uninstallPlugin(pluginName: string): Promise<PluginUninstallResult>;
  listEjectedPlugins(): Promise<InstalledPluginInfo[]>;
  ejectPlugin(pluginName: string): Promise<EjectResult>;
  syncPlugin(pluginName: string): Promise<SyncResult>;
  reinjectPlugin(pluginName: string): Promise<ReinjectResult>;
}

export interface CoreStatusLike {
  ejected: boolean;
  ejectedPath: string;
  monorepoPath: string;
  corePackagePath: string;
  coreDistPath: string;
  version: string;
  npmVersion: string;
  commitHash: string | null;
  localChanges: boolean;
  upstream: unknown;
}

export interface CoreManagerLike {
  getCoreStatus(): Promise<CoreStatusLike>;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isPluginManagerLike(
  candidate: unknown,
): candidate is PluginManagerLike {
  if (!isObjectRecord(candidate)) return false;

  return (
    typeof candidate.refreshRegistry === "function" &&
    typeof candidate.listInstalledPlugins === "function" &&
    typeof candidate.getRegistryPlugin === "function" &&
    typeof candidate.searchRegistry === "function" &&
    typeof candidate.installPlugin === "function" &&
    typeof candidate.uninstallPlugin === "function"
  );
}

export function isCoreManagerLike(
  candidate: unknown,
): candidate is CoreManagerLike {
  if (!isObjectRecord(candidate)) return false;
  return typeof candidate.getCoreStatus === "function";
}
