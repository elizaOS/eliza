import type {
  AppUiExtensionConfig,
  RegistryAppMeta,
  RegistryAppSessionFeature,
  RegistryAppSessionMeta,
  RegistryAppSessionMode,
  RegistryAppViewerMeta,
  RegistryPluginInfo as RegistryClientPluginInfo,
  RegistrySearchResult as RegistryClientSearchResult,
} from "./registry-client-types.ts";

export type { AppUiExtensionConfig };

export type RegistryVersionSupport = RegistryClientPluginInfo["supports"];
export type RegistryPluginNpmInfo = RegistryClientPluginInfo["npm"];
export type RegistryPluginViewerInfo = RegistryAppViewerMeta;
export type RegistryPluginAppSessionMode = RegistryAppSessionMode;
export type RegistryPluginAppSessionFeature = RegistryAppSessionFeature;
export type RegistryPluginAppSessionInfo = RegistryAppSessionMeta;
export type RegistryPluginAppMeta = RegistryAppMeta;

export interface RegistryPluginInfo extends RegistryClientPluginInfo {
  displayName?: string;
  launchType?: string;
  launchUrl?: string | null;
  viewer?: RegistryPluginViewerInfo;
  uiExtension?: AppUiExtensionConfig;
  category?: string;
  capabilities?: string[];
  icon?: string | null;
  heroImage?: string | null;
  runtimePlugin?: string;
  session?: RegistryPluginAppSessionInfo;
}

export interface RegistrySearchResult extends RegistryClientSearchResult {
  version?: string | null;
  npmPackage?: string;
}

export interface InstalledPluginInfo {
  name: string;
  version?: string;
  installedAt?: string;
  releaseStream?: "latest" | "beta";
  requestedVersion?: string;
  latestVersion?: string | null;
  betaVersion?: string | null;
}

export interface PluginInstallOptionsLike {
  version?: string;
  releaseStream?: "latest" | "beta";
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
  requestedVersion?: string;
  releaseStream?: "latest" | "beta";
  latestVersion?: string | null;
  betaVersion?: string | null;
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
    options?: PluginInstallOptionsLike,
  ): Promise<PluginInstallResult>;
  updatePlugin?(
    pluginName: string,
    onProgress?: (progress: InstallProgressLike) => void,
    options?: PluginInstallOptionsLike,
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
