import type { Plugin } from "../../types/plugin.ts";
import { pluginAction } from "./actions/plugin.ts";
import { pluginConfigurationStatusProvider } from "./providers/pluginConfigurationStatus.ts";
import { pluginStateProvider } from "./providers/pluginStateProvider.ts";
import { registryPluginsProvider } from "./providers/registryPluginsProvider.ts";
import { CoreManagerService } from "./services/coreManagerService.ts";
import { PluginManagerService } from "./services/pluginManagerService.ts";
import * as pluginRegistry from "./services/pluginRegistryService.ts";
import * as types from "./types.ts";

// --- Re-exports ---

// Actions
export {
	createPluginAction,
	type PluginMode,
	type PluginSubaction,
	pluginAction,
} from "./actions/plugin.ts";
export type { ExtendedRuntime } from "./coreExtensions.ts";
// Core extensions
export {
	applyRuntimeExtensions,
	extendRuntimeWithComponentUnregistration,
} from "./coreExtensions.ts";
// Providers
export { pluginConfigurationStatusProvider } from "./providers/pluginConfigurationStatus.ts";
export { pluginStateProvider } from "./providers/pluginStateProvider.ts";
export { registryPluginsProvider } from "./providers/registryPluginsProvider.ts";
// Relevance utilities
export {
	buildKeywordRegex,
	buildProviderKeywords,
	COMMON_CONNECTOR_KEYWORDS,
	isProviderRelevant,
	keywordsFromPluginNames,
	PLUGIN_MANAGER_BASE_KEYWORDS,
} from "./providers/relevance.ts";
// Security helpers (re-exported from @elizaos/core for consumers like
// plugin-app-control).
export {
	hasAdminAccess,
	hasOwnerAccess,
	type SecurityDeps,
} from "./security.ts";
export type {
	CoreEjectResult,
	CoreReinjectResult,
	CoreStatus,
	CoreSyncResult,
	UpstreamMetadata as CoreUpstreamMetadata,
} from "./services/coreManagerService.ts";
export { CoreManagerService } from "./services/coreManagerService.ts";
export { PluginConfigurationService } from "./services/pluginConfigurationService.ts";
// Services
export { PluginManagerService } from "./services/pluginManagerService.ts";
export type {
	CloneResult,
	PluginSearchResult,
	RegistryPlugin,
} from "./services/pluginRegistryService.ts";
export {
	clonePlugin,
	getAllPlugins,
	getPluginDetails,
	getRegistryEntry,
	listNonAppPlugins,
	loadRegistry,
	refreshRegistry,
	resetRegistryCache,
	searchNonAppPlugins,
	searchPluginsByContent,
} from "./services/pluginRegistryService.ts";
export type {
	ComponentRegistration,
	EjectedPluginInfo,
	EjectResult,
	InstallProgress,
	InstallResult,
	LoadPluginParams,
	PluginComponents,
	PluginManagerConfig,
	PluginMetadata,
	PluginRegistry,
	PluginState,
	ReinjectResult,
	SyncResult,
	UninstallResult,
	UnloadPluginParams,
	UpstreamMetadata,
} from "./types.ts";
// Types
export {
	PluginManagerServiceType,
	PluginStatus,
} from "./types.ts";

// Path utilities
export {
	resolveConfigPath,
	resolveStateDir,
	resolveUserPath,
} from "./utils/paths.ts";

// Namespace re-exports for backward compatibility
export { pluginRegistry, types };

// Plugin definition
export const pluginManagerPlugin: Plugin = {
	name: "plugin-manager",
	description:
		"Plugin discovery, install, eject/sync, registry search, and creation",
	actions: [pluginAction],
	providers: [
		pluginConfigurationStatusProvider,
		pluginStateProvider,
		registryPluginsProvider,
	],
	services: [PluginManagerService, CoreManagerService],
};

export default pluginManagerPlugin;
