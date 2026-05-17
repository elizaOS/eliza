import type { EventPayload, EventPayloadMap } from "../../types/events.ts";
import type { Plugin as ElizaPlugin } from "../../types/plugin.ts";
import type { ServiceTypeName } from "../../types/service.ts";

// Service type declarations for plugin manager
// Note: When used as part of the core package, these augment the ServiceTypeRegistry
// directly. When consumed externally via @elizaos/core, declare module "@elizaos/core" instead.
declare module "../../types/service.ts" {
	interface ServiceTypeRegistry {
		PLUGIN_MANAGER: "plugin_manager";
		PLUGIN_CONFIGURATION: "plugin_configuration";
		REGISTRY: "registry";
		CORE_MANAGER: "core_manager";
	}
}

export const PluginManagerServiceType = {
	PLUGIN_MANAGER: "plugin_manager" as ServiceTypeName,
	PLUGIN_CONFIGURATION: "plugin_configuration" as ServiceTypeName,
	REGISTRY: "registry" as ServiceTypeName,
	CORE_MANAGER: "core_manager" as ServiceTypeName,
} as const;

export enum PluginStatus {
	READY = "ready",
	LOADED = "loaded",
	ERROR = "error",
	UNLOADED = "unloaded",
}

export interface PluginComponents {
	actions: Set<string>;
	providers: Set<string>;
	services: Set<string>;
	eventHandlers: Map<
		string,
		Set<
			(
				params: EventPayloadMap[keyof EventPayloadMap] | EventPayload,
			) => Promise<void>
		>
	>;
}

export interface ComponentRegistration {
	pluginId: string;
	componentType: "action" | "provider" | "service" | "eventHandler";
	componentName: string;
	timestamp: number;
}

export interface PluginState {
	id: string;
	name: string;
	status: PluginStatus;
	plugin?: ElizaPlugin;
	error?: string;
	createdAt: number;
	loadedAt?: number;
	unloadedAt?: number;
	version?: string;
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
	force?: boolean;
}

export interface PluginManagerConfig {
	pluginDirectory?: string;
}

export interface InstallProgress {
	phase:
		| "fetching-registry"
		| "resolving"
		| "downloading"
		| "extracting"
		| "installing-deps"
		| "validating"
		| "configuring"
		| "restarting"
		| "complete"
		| "error";
	pluginName?: string;
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

// --- Eject / Sync / Reinject Types ---

export interface UpstreamMetadata {
	$schema: "eliza-upstream-v1";
	source: string;
	gitUrl: string;
	branch: string;
	commitHash: string;
	ejectedAt: string;
	npmPackage: string;
	npmVersion: string;
	lastSyncAt: string | null;
	localCommits: number;
}

export interface EjectedPluginInfo {
	name: string;
	path: string;
	version: string;
	upstream: UpstreamMetadata | null;
}

export interface EjectResult {
	success: boolean;
	pluginName: string;
	ejectedPath: string;
	upstreamCommit: string;
	requiresRestart: boolean;
	error?: string;
}

export interface SyncResult {
	success: boolean;
	pluginName: string;
	ejectedPath: string;
	upstreamCommits: number;
	localChanges: boolean;
	conflicts: string[];
	commitHash: string;
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
