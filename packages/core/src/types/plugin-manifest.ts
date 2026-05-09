/**
 * Plugin Manifest Types
 *
 * Defines the structure for plugin manifests (elizaos.plugin.json).
 * These manifests describe plugin metadata, configuration schemas,
 * and capabilities for discovery and loading.
 *
 * @module types/plugin-manifest
 */

import type { JsonValue } from "./primitives.ts";

/**
 * Plugin kind identifier for specialized plugins.
 */
export type PluginKind =
	| "memory"
	| "channel"
	| "provider"
	| "skill"
	| "database"
	| "app";

/**
 * Plugin origin indicates where the plugin was discovered.
 */
export type PluginOrigin =
	| "bundled"
	| "global"
	| "workspace"
	| "config"
	| "npm";

/**
 * UI hints for plugin configuration fields.
 */
export interface PluginConfigUiHint {
	/** Display label for the field */
	label?: string;
	/** Help text or description */
	help?: string;
	/** Mark as advanced configuration */
	advanced?: boolean;
	/** Mark as sensitive (e.g., API keys) */
	sensitive?: boolean;
	/** Placeholder text for input */
	placeholder?: string;
	/** Field type hint for UI rendering */
	type?: "text" | "password" | "number" | "boolean" | "select" | "textarea";
	/** Options for select fields */
	options?: Array<{ value: string; label: string }>;
}

/**
 * Plugin skill definition within a manifest.
 */
export interface PluginSkillDefinition {
	/** Skill identifier */
	id: string;
	/** Human-readable name */
	name?: string;
	/** Description of the skill */
	description?: string;
	/** Path to the skill file relative to plugin root */
	path?: string;
	/** Required binary dependencies */
	requiresBins?: string[];
	/** Required environment variables */
	requiresEnv?: string[];
	/** Required config keys */
	requiresConfig?: string[];
}

/**
 * Plugin gateway method definition.
 */
export interface PluginGatewayMethod {
	/** Method name */
	method: string;
	/** Method description */
	description?: string;
	/** Input schema (JSON Schema) */
	inputSchema?: Record<string, JsonValue>;
	/** Output schema (JSON Schema) */
	outputSchema?: Record<string, JsonValue>;
}

export type PluginManifestAppSessionMode =
	| "viewer"
	| "spectate-and-steer"
	| "external";

export type PluginManifestAppSessionFeature =
	| "commands"
	| "telemetry"
	| "pause"
	| "resume"
	| "suggestions";

export interface PluginManifestAppViewer {
	url: string;
	embedParams?: Record<string, string>;
	postMessageAuth?: boolean;
	sandbox?: string;
}

export interface PluginManifestAppSession {
	mode: PluginManifestAppSessionMode;
	features?: PluginManifestAppSessionFeature[];
}

export interface PluginManifestApp {
	displayName?: string;
	category?: string;
	launchType?: string;
	launchUrl?: string | null;
	icon?: string | null;
	capabilities?: string[];
	minPlayers?: number | null;
	maxPlayers?: number | null;
	runtimePlugin?: string;
	viewer?: PluginManifestAppViewer;
	session?: PluginManifestAppSession;
	bridgeExport?: string;
}

/**
 * Runtime context passed to a plugin package's lightweight auto-enable check.
 *
 * This is plugin author API surface and intentionally belongs in core so plugin
 * packages do not depend on app/shared packages just to type an optional
 * manifest predicate.
 */
export interface PluginAutoEnableContext {
	/** Process env. Read-only — predicates must not mutate. */
	env: NodeJS.ProcessEnv;
	/** The user's resolved Eliza config. Read-only. */
	config: Record<string, unknown>;
	/** True when the runtime is hosted inside a Capacitor native shell. */
	isNativePlatform: boolean;
}

/**
 * Shape of the small check module declared by package.json
 * `elizaos.plugin.autoEnableModule`.
 */
export interface PluginAutoEnableModule {
	shouldEnable: (ctx: PluginAutoEnableContext) => boolean | Promise<boolean>;
	shouldForce?: (ctx: PluginAutoEnableContext) => boolean;
}

/**
 * Plugin manifest structure (elizaos.plugin.json).
 */
export interface PluginManifest {
	/** Unique plugin identifier */
	id: string;
	/** Human-readable plugin name */
	name?: string;
	/** Plugin description */
	description?: string;
	/** Plugin version (semver) */
	version?: string;
	/** Plugin kind for specialized handling */
	kind?: PluginKind;
	/** Configuration schema (JSON Schema) */
	configSchema: Record<string, JsonValue>;
	/** UI hints for configuration fields */
	uiHints?: Record<string, PluginConfigUiHint>;
	/** Channel identifiers this plugin provides */
	channels?: string[];
	/** Provider identifiers this plugin provides */
	providers?: string[];
	/** Skills this plugin provides */
	skills?: string[] | PluginSkillDefinition[];
	/** Gateway methods this plugin exposes */
	gatewayMethods?: string[] | PluginGatewayMethod[];
	/** CLI commands this plugin registers */
	cliCommands?: string[];
	/** Required secrets/API keys */
	requiredSecrets?: string[];
	/** Optional secrets/API keys */
	optionalSecrets?: string[];
	/** Plugin dependencies (other plugin IDs) */
	dependencies?: string[];
	/** Minimum elizaOS version required */
	minElizaVersion?: string;
	/** Plugin author */
	author?: string;
	/** Plugin homepage URL */
	homepage?: string;
	/** Plugin repository URL */
	repository?: string;
	/** Plugin license */
	license?: string;
	/** Plugin keywords for search */
	keywords?: string[];
	/** Optional app metadata for viewer/session-capable plugins */
	app?: PluginManifestApp;
}

/**
 * Result of loading a plugin manifest.
 */
export type PluginManifestLoadResult =
	| { ok: true; manifest: PluginManifest; manifestPath: string }
	| { ok: false; error: string; manifestPath: string };

/**
 * Plugin diagnostic message.
 */
export interface PluginDiagnostic {
	/** Diagnostic severity */
	level: "warn" | "error" | "info";
	/** Diagnostic message */
	message: string;
	/** Associated plugin ID */
	pluginId?: string;
	/** Source file path */
	source?: string;
}

/**
 * Plugin candidate discovered during scanning.
 */
export interface PluginCandidate {
	/** Derived plugin ID hint */
	idHint: string;
	/** Path to the plugin entry point */
	source: string;
	/** Plugin root directory */
	rootDir: string;
	/** Where the plugin was discovered */
	origin: PluginOrigin;
	/** Workspace directory if workspace-scoped */
	workspaceDir?: string;
	/** Package name from package.json */
	packageName?: string;
	/** Package version from package.json */
	packageVersion?: string;
	/** Package description from package.json */
	packageDescription?: string;
	/** Package directory */
	packageDir?: string;
	/** Extracted package manifest metadata */
	packageManifest?: elizaOSPackageManifest;
}

/**
 * Result of plugin discovery.
 */
export interface PluginDiscoveryResult {
	/** Discovered plugin candidates */
	candidates: PluginCandidate[];
	/** Discovery diagnostics */
	diagnostics: PluginDiagnostic[];
}

/**
 * Plugin manifest record with additional metadata.
 */
export interface PluginManifestRecord {
	/** Plugin ID */
	id: string;
	/** Plugin name */
	name?: string;
	/** Plugin description */
	description?: string;
	/** Plugin version */
	version?: string;
	/** Plugin kind */
	kind?: PluginKind;
	/** Channels provided */
	channels: string[];
	/** Providers provided */
	providers: string[];
	/** Skills provided */
	skills: string[];
	/** Plugin origin */
	origin: PluginOrigin;
	/** Workspace directory */
	workspaceDir?: string;
	/** Plugin root directory */
	rootDir: string;
	/** Plugin entry point source */
	source: string;
	/** Path to the manifest file */
	manifestPath: string;
	/** Cache key for schema validation */
	schemaCacheKey?: string;
	/** Configuration schema */
	configSchema?: Record<string, JsonValue>;
	/** Configuration UI hints */
	configUiHints?: Record<string, PluginConfigUiHint>;
}

/**
 * Plugin manifest registry containing all discovered manifests.
 */
export interface PluginManifestRegistry {
	/** Plugin manifest records */
	plugins: PluginManifestRecord[];
	/** Registry diagnostics */
	diagnostics: PluginDiagnostic[];
}

/**
 * Channel metadata from package.json.
 */
export interface PluginPackageChannel {
	/** Channel identifier */
	id?: string;
	/** Display label */
	label?: string;
	/** Selection label for onboarding */
	selectionLabel?: string;
	/** Detail label */
	detailLabel?: string;
	/** Documentation path */
	docsPath?: string;
	/** Documentation label */
	docsLabel?: string;
	/** Short description */
	blurb?: string;
	/** Display order */
	order?: number;
	/** Alternative names */
	aliases?: string[];
	/** Channels this one is preferred over */
	preferOver?: string[];
	/** System image name (for icons) */
	systemImage?: string;
	/** Show configured status */
	showConfigured?: boolean;
	/** Allow from quickstart */
	quickstartAllowFrom?: boolean;
}

/**
 * Installation metadata from package.json.
 */
export interface PluginPackageInstall {
	/** NPM package specifier */
	npmSpec?: string;
	/** Local path for development */
	localPath?: string;
	/** Default installation choice */
	defaultChoice?: "npm" | "local";
}

/**
 * elizaOS-specific metadata in package.json.
 */
export interface elizaOSPackageManifest {
	/** Entry point extensions */
	extensions?: string[];
	/** Channel metadata */
	channel?: PluginPackageChannel;
	/** Installation metadata */
	install?: PluginPackageInstall;
}

/**
 * Standard package.json structure with elizaOS metadata.
 */
export interface PackageManifest {
	/** Package name */
	name?: string;
	/** Package version */
	version?: string;
	/** Package description */
	description?: string;
	/** elizaOS-specific metadata */
	elizaos?: elizaOSPackageManifest;
}

/**
 * Plugin record in the runtime registry.
 */
export interface PluginRecord {
	/** Plugin ID */
	id: string;
	/** Plugin name */
	name: string;
	/** Plugin description */
	description?: string;
	/** Plugin version */
	version?: string;
	/** Plugin kind */
	kind?: PluginKind;
	/** Plugin entry point source */
	source: string;
	/** Plugin origin */
	origin: PluginOrigin;
	/** Workspace directory */
	workspaceDir?: string;
	/** Whether the plugin is enabled */
	enabled: boolean;
	/** Plugin status */
	status: "loaded" | "disabled" | "error" | "pending";
	/** Error message if status is error */
	error?: string;
	/** Registered tool names */
	toolNames: string[];
	/** Registered hook names */
	hookNames: string[];
	/** Channel IDs */
	channelIds: string[];
	/** Provider IDs */
	providerIds: string[];
	/** Gateway methods */
	gatewayMethods: string[];
	/** CLI commands */
	cliCommands: string[];
	/** Services */
	services: string[];
	/** Commands */
	commands: string[];
	/** HTTP handler count */
	httpHandlers: number;
	/** Hook count */
	hookCount: number;
	/** Has config schema */
	configSchema: boolean;
	/** Config UI hints */
	configUiHints?: Record<string, PluginConfigUiHint>;
	/** Config JSON schema */
	configJsonSchema?: Record<string, JsonValue>;
}

/**
 * Plugin registry containing all loaded plugins.
 */
export interface PluginRegistry {
	/** Plugin records */
	plugins: PluginRecord[];
	/** Registry diagnostics */
	diagnostics: PluginDiagnostic[];
}
