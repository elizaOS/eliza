import type { Plugin } from "../../types/plugin.ts";
import { coreStatusAction } from "./actions/coreStatusAction.ts";
import { listEjectedPluginsAction } from "./actions/listEjectedPluginsAction.ts";
import { getPluginDetailsAction, searchPluginAction } from "./actions/searchPluginAction.ts";
import { pluginConfigurationStatusProvider } from "./providers/pluginConfigurationStatus.ts";
import { pluginStateProvider } from "./providers/pluginStateProvider.ts";
import { registryPluginsProvider } from "./providers/registryPluginsProvider.ts";
import { CoreManagerService } from "./services/coreManagerService.ts";
import { PluginManagerService } from "./services/pluginManagerService.ts";
import { PluginConfigurationService } from "./services/pluginConfigurationService.ts";
import * as pluginRegistry from "./services/pluginRegistryService.ts";
import * as types from "./types.ts";

// --- Re-exports ---

// Services
export { PluginManagerService } from "./services/pluginManagerService.ts";
export { CoreManagerService } from "./services/coreManagerService.ts";
export type {
  CoreEjectResult,
  CoreSyncResult,
  CoreReinjectResult,
  CoreStatus,
  UpstreamMetadata as CoreUpstreamMetadata,
} from "./services/coreManagerService.ts";
export { PluginConfigurationService } from "./services/pluginConfigurationService.ts";
export {
  loadRegistry,
  getRegistryEntry,
  searchPluginsByContent,
  getPluginDetails,
  getAllPlugins,
  listNonAppPlugins,
  searchNonAppPlugins,
  refreshRegistry,
  clonePlugin,
  resetRegistryCache,
} from "./services/pluginRegistryService.ts";
export type {
  RegistryPlugin,
  PluginSearchResult,
  CloneResult,
} from "./services/pluginRegistryService.ts";

// Actions
export { coreStatusAction } from "./actions/coreStatusAction.ts";
export { searchPluginAction, getPluginDetailsAction } from "./actions/searchPluginAction.ts";
export { listEjectedPluginsAction } from "./actions/listEjectedPluginsAction.ts";

// Providers
export { pluginConfigurationStatusProvider } from "./providers/pluginConfigurationStatus.ts";
export { pluginStateProvider } from "./providers/pluginStateProvider.ts";
export { registryPluginsProvider } from "./providers/registryPluginsProvider.ts";

// Relevance utilities
export {
  buildProviderKeywords,
  keywordsFromPluginNames,
  buildKeywordRegex,
  isProviderRelevant,
  PLUGIN_MANAGER_BASE_KEYWORDS,
  COMMON_CONNECTOR_KEYWORDS,
} from "./providers/relevance.ts";

// Types
export {
  PluginManagerServiceType,
  PluginStatus,
} from "./types.ts";
export type {
  PluginComponents,
  ComponentRegistration,
  PluginState,
  PluginRegistry,
  LoadPluginParams,
  UnloadPluginParams,
  PluginManagerConfig,
  InstallProgress,
  PluginMetadata,
  UpstreamMetadata,
  EjectedPluginInfo,
  EjectResult,
  SyncResult,
  ReinjectResult,
  InstallResult,
  UninstallResult,
} from "./types.ts";

// Core extensions
export {
  applyRuntimeExtensions,
  extendRuntimeWithEventUnregistration,
  extendRuntimeWithComponentUnregistration,
} from "./coreExtensions.ts";
export type { ExtendedRuntime } from "./coreExtensions.ts";

// Path utilities
export {
  resolveUserPath,
  resolveStateDir,
  resolveConfigPath,
} from "./utils/paths.ts";

// Namespace re-exports for backward compatibility
export { pluginRegistry, types };

// Plugin definition
export const pluginManagerPlugin: Plugin = {
  name: "plugin-manager",
  description: "Read-only plugin discovery and plugin/core status introspection",
  actions: [coreStatusAction, getPluginDetailsAction, searchPluginAction, listEjectedPluginsAction],
  providers: [pluginConfigurationStatusProvider, pluginStateProvider, registryPluginsProvider],
  evaluators: [],
  services: [PluginManagerService, CoreManagerService],
};

export default pluginManagerPlugin;
