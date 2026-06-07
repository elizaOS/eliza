declare module "@elizaos/agent" {
  export type ElizaConfig = import("@elizaos/shared").ElizaConfig & {
    connectors?: Record<string, Record<string, unknown>>;
    streaming?: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };

  export type ReleaseChannel = string;
  export type RolesConfig = Record<string, unknown>;
  export type AdvancedCapabilityPluginId =
    | "experience"
    | "todos"
    | "personality";

  export interface PluginParamInfo {
    key: string;
    required: boolean;
    sensitive: boolean;
    type: string;
    description: string;
    default?: string;
  }

  export interface PluginRuntimeApplyResult {
    mode:
      | "none"
      | "config_apply"
      | "plugin_reload"
      | "runtime_reload"
      | "restart_required";
    requiresRestart: boolean;
    restartedRuntime: boolean;
    loadedPackages: string[];
    unloadedPackages: string[];
    reloadedPackages: string[];
    appliedConfigPackage: string | null;
    reason: string;
  }

  export interface ResolvedPlugin {
    name: string;
    plugin: import("@elizaos/core").Plugin;
  }

  export interface PluginWidgetDeclarationServer {
    pluginId: string;
    id: string;
  }

  export interface AgentManifestPluginParameter {
    type?: string;
    description?: string;
    required?: boolean;
    optional?: boolean;
    sensitive?: boolean;
    default?: string | number | boolean;
    options?: string[];
  }

  export interface AgentPluginEntry {
    id: string;
    name: string;
    description: string;
    tags: string[];
    enabled: boolean;
    configured: boolean;
    envKey: string | null;
    category:
      | "ai-provider"
      | "connector"
      | "streaming"
      | "database"
      | "app"
      | "feature";
    source: "bundled" | "store";
    configKeys: string[];
    parameters: import("@elizaos/shared").PluginParamDef[];
    validationErrors: Array<{ field: string; message: string }>;
    validationWarnings: Array<{ field: string; message: string }>;
    npmName?: string;
    directory?: string | null;
    registryKind?: string;
    origin?: "builtin" | "third-party" | string;
    registrySource?: string;
    support?: "first-party" | "community" | string;
    builtIn?: boolean;
    firstParty?: boolean;
    thirdParty?: boolean;
    status?: string;
    version?: string;
    releaseStream?: "latest" | "beta";
    requestedVersion?: string;
    latestVersion?: string | null;
    betaVersion?: string | null;
    pluginDeps?: string[];
    isActive?: boolean;
    loadError?: string;
    configUiHints?: Record<string, Record<string, unknown>>;
    icon?: string | null;
    homepage?: string;
    repository?: string;
    setupGuideUrl?: string;
    autoEnabled?: boolean;
    managementMode?: "standard" | "core-optional";
    capabilityStatus?:
      | "loaded"
      | "auto-enabled"
      | "blocked"
      | "missing-prerequisites"
      | "disabled";
    capabilityReason?: string | null;
    prerequisites?: Array<{ label: string; met: boolean }>;
  }

  export interface RegistryPluginManagerInfo {
    name: string;
    displayName?: string;
    launchType?: string;
    launchUrl?: string | null;
    viewer?: unknown;
    uiExtension?: unknown;
    category?: string;
    capabilities?: string[];
    icon?: string | null;
    heroImage?: string | null;
    runtimePlugin?: string;
    session?: unknown;
    npm: {
      package: string;
      v1Version?: string | null;
      v2Version?: string | null;
      v0Version?: string | null;
    };
    supports?: unknown;
    directory?: string | null;
    registryKind?: string;
    kind?: string;
    origin?: "builtin" | "third-party" | string;
    source?: string;
    support?: "first-party" | "community" | string;
    builtIn?: boolean;
    firstParty?: boolean;
    thirdParty?: boolean;
    status?: string;
    homepage?: string | null;
    gitRepo?: string;
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

  export interface InstallProgressLike {
    phase: string;
    message: string;
    pluginName?: string;
  }

  export interface PluginInstallOptionsLike {
    version?: string;
    releaseStream?: "latest" | "beta";
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
    refreshRegistry(): Promise<Map<string, RegistryPluginManagerInfo>>;
    listInstalledPlugins(): Promise<InstalledPluginInfo[]>;
    getRegistryPlugin(name: string): Promise<RegistryPluginManagerInfo | null>;
    searchRegistry(query: string, limit?: number): Promise<unknown[]>;
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

  export interface CoreManagerLike {
    getCoreStatus(): Promise<{
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
    }>;
  }

  export type InstallPhase =
    | "resolving"
    | "downloading"
    | "installing-deps"
    | "validating"
    | "configuring"
    | "restarting"
    | "complete"
    | "error";
  export interface InstallProgress {
    phase: InstallPhase;
    pluginName: string;
    message: string;
  }
  export type ProgressCallback = (progress: InstallProgress) => void;
  export interface InstallResult {
    success: boolean;
    pluginName: string;
    version: string;
    installPath: string;
    requiresRestart: boolean;
    error?: string;
  }
  export interface UninstallResult {
    success: boolean;
    pluginName: string;
    requiresRestart: boolean;
    error?: string;
  }

  export const loadElizaConfig: (...args: unknown[]) => ElizaConfig;
  export const saveElizaConfig: (...args: unknown[]) => void;
  export const persistConfigEnv: (...args: unknown[]) => void;
  export const resolveStateDir: (...args: unknown[]) => string;
  export const createIntegrationTelemetrySpan: (...args: unknown[]) => unknown;
  export const CONNECTOR_ENV_MAP: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  export const CORE_PLUGINS: readonly string[];
  export const OPTIONAL_CORE_PLUGINS: readonly string[];

  export function applyAdvancedCapabilitiesConfig(
    config: ElizaConfig,
    enabled: boolean,
  ): void;
  export function applyPluginRuntimeMutation(options: {
    runtime: import("@elizaos/core").AgentRuntime | null;
    previousConfig: ElizaConfig;
    nextConfig: ElizaConfig;
    previousResolvedPlugins?: ResolvedPlugin[];
    nextResolvedPlugins?: ResolvedPlugin[];
    changedPluginId?: string;
    changedPluginPackage?: string;
    config?: Record<string, string>;
    forceReloadPackages?: string[];
    expectRuntimeGraphChange?: boolean;
    reason: string;
    restartRuntime?: (reason: string) => Promise<boolean>;
  }): Promise<PluginRuntimeApplyResult>;
  export function discoverPluginsFromManifest(): AgentPluginEntry[];
  export function findPrimaryEnvKey(configKeys: string[]): string | null;
  export function getPluginWidgets(
    pluginId: string,
    runtimePlugins?: ReadonlyArray<import("@elizaos/core").Plugin>,
  ): PluginWidgetDeclarationServer[];
  export function installPlugin(
    pluginName: string,
    onProgress?: ProgressCallback,
    requestedVersion?: string,
  ): Promise<InstallResult>;
  export function installAndRestart(
    pluginName: string,
    onProgress?: ProgressCallback,
    requestedVersion?: string,
  ): Promise<InstallResult>;
  export function isAdvancedCapabilityPluginId(
    pluginId: string,
  ): pluginId is AdvancedCapabilityPluginId;
  export function isVaultRef(value: unknown): boolean;
  export function listInstalledPlugins(): Promise<InstalledPluginInfo[]>;
  export function parseVaultRef(value: string): string | null;
  export function readBundledPluginPackageMetadata(
    packageRoot: string,
    dirName: string,
    npmName?: string,
  ): {
    description?: string;
    tags?: string[];
    configKeys?: string[];
    pluginParameters?: Record<string, AgentManifestPluginParameter>;
    configUiHints?: Record<string, Record<string, unknown>>;
    icon?: string | null;
    logoUrl?: string | null;
    homepage?: string;
    repository?: string;
    setupGuideUrl?: string;
  };
  export function resolveAdvancedCapabilitiesEnabled(
    config: Pick<ElizaConfig, "plugins"> | null | undefined,
  ): boolean;
  export function resolveDefaultAgentWorkspaceDir(): string;
  export function resolvePlugins(
    config: ElizaConfig,
    options?: { quiet?: boolean },
  ): Promise<ResolvedPlugin[]>;
  export function uninstallPlugin(pluginName: string): Promise<UninstallResult>;
  export function uninstallAndRestart(
    pluginName: string,
  ): Promise<UninstallResult>;
  export function validatePluginConfig(
    pluginId: string,
    category: string,
    envKey: string | null,
    configKeys: string[],
    providedConfig?: Record<string, string>,
    paramDefs?: PluginParamInfo[],
  ): {
    valid: boolean;
    errors: Array<{ field: string; message: string }>;
    warnings: Array<{ field: string; message: string }>;
  };
}
