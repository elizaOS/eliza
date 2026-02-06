import { type ServiceTypeName, type Plugin as ElizaPlugin } from '@elizaos/core';

// Service type declarations for plugin manager
declare module '@elizaos/core' {
  interface ServiceTypeRegistry {
    PLUGIN_MANAGER: 'plugin_manager';
    PLUGIN_CONFIGURATION: 'plugin_configuration';
    REGISTRY: 'registry';
  }
}

export const PluginManagerServiceType = {
  PLUGIN_MANAGER: 'plugin_manager' as ServiceTypeName,
  PLUGIN_CONFIGURATION: 'plugin_configuration' as ServiceTypeName,
  REGISTRY: 'registry' as ServiceTypeName,
} as const;

export enum PluginStatus {
  BUILDING = 'building',
  READY = 'ready',
  LOADED = 'loaded',
  ERROR = 'error',
  UNLOADED = 'unloaded',
  NEEDS_CONFIGURATION = 'needs_configuration',
}

export interface PluginEnvironmentVariable {
  name: string;
  description: string;
  sensitive: boolean;
  required: boolean;
  defaultValue?: string;
  validation?: {
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    enum?: string[];
  };
}

export interface PluginComponents {
  actions: Set<string>;
  providers: Set<string>;
  evaluators: Set<string>;
  services: Set<string>;
  eventHandlers: Map<string, Set<(params: Record<string, unknown>) => Promise<void>>>;
}

export interface ComponentRegistration {
  pluginId: string;
  componentType: 'action' | 'provider' | 'evaluator' | 'service' | 'eventHandler';
  componentName: string;
  timestamp: number;
}

export interface PluginState {
  id: string;
  name: string;
  status: PluginStatus;
  plugin?: ElizaPlugin;
  missingEnvVars: string[];
  buildLog: string[];
  sourceCode?: string;
  packageJson?: Record<string, unknown>;
  error?: string;
  createdAt: number;
  loadedAt?: number;
  unloadedAt?: number;
  version?: string;
  dependencies?: Record<string, string>;
  // Configuration-related fields
  configurationStatus?: 'unconfigured' | 'partial' | 'complete';
  requiredConfiguration?: PluginEnvironmentVariable[];
  configurationErrors?: string[];
  // Component tracking
  components?: PluginComponents;
}

export interface PluginRegistry {
  plugins: Map<string, PluginState>;
  getPlugin(id: string): PluginState | undefined;
  getAllPlugins(): PluginState[];
  getLoadedPlugins(): PluginState[];
  updatePluginState(id: string, update: Partial<PluginState>): void;
}

export interface LoadPluginParams {
  pluginId: string;
  force?: boolean;
}

export interface UnloadPluginParams {
  pluginId: string;
}

export interface PluginManagerConfig {
  maxBuildAttempts?: number;
  buildTimeout?: number;
  pluginDirectory?: string;
  enableHotReload?: boolean;
}

export interface InstallProgress {
  phase: 'downloading' | 'extracting' | 'installing' | 'validating' | 'complete';
  progress: number; // 0-100
  message: string;
}

export interface PluginMetadata {
  name: string;
  description: string;
  author: string;
  repository: string;
  versions: string[];
  latestVersion: string;
  runtimeVersion: string;
  maintainer: string;
  tags?: string[];
  categories?: string[];
}
