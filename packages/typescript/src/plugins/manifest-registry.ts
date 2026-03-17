/**
 * Plugin Manifest Registry
 *
 * Loads and caches plugin manifests (elizaos.plugin.json).
 *
 * @module plugins/manifest-registry
 */

import fs from "node:fs";
import path from "node:path";
import type {
	PluginCandidate,
	PluginConfigUiHint,
	PluginDiagnostic,
	PluginKind,
	PluginManifest,
	PluginManifestLoadResult,
	PluginManifestRecord,
	PluginManifestRegistry,
} from "../types/plugin-manifest.ts";
import type { JsonValue } from "../types/primitives.ts";
import { discoverPlugins, resolveUserPath } from "./discovery.ts";

/** Plugin manifest filename */
export const PLUGIN_MANIFEST_FILENAME = "elizaos.plugin.json";

/** Alternative manifest filenames for compatibility */
export const PLUGIN_MANIFEST_FILENAMES = [PLUGIN_MANIFEST_FILENAME] as const;

/** Default manifest cache TTL in milliseconds */
const DEFAULT_MANIFEST_CACHE_MS = 200;

/** Registry cache storage */
const registryCache = new Map<
	string,
	{ expiresAt: number; registry: PluginManifestRegistry }
>();

/**
 * Configuration for plugins loading.
 */
export interface PluginsConfig {
	/** Plugin allow list */
	allow?: string[];
	/** Plugin deny list */
	deny?: string[];
	/** Additional plugin load paths */
	loadPaths?: string[];
	/** Plugin entries configuration */
	entries?: Record<
		string,
		{ enabled?: boolean; config?: Record<string, JsonValue> }
	>;
	/** Plugin slots configuration */
	slots?: { memory?: string };
}

/**
 * Normalized plugins configuration.
 */
export interface NormalizedPluginsConfig {
	allow: string[];
	deny: string[];
	loadPaths: string[];
	entries: Record<
		string,
		{ enabled?: boolean; config?: Record<string, JsonValue> }
	>;
	slots: { memory?: string };
}

/**
 * Normalize plugins configuration with defaults.
 */
export function normalizePluginsConfig(
	config: Partial<PluginsConfig> | undefined,
): NormalizedPluginsConfig {
	return {
		allow: Array.isArray(config?.allow) ? config.allow : [],
		deny: Array.isArray(config?.deny) ? config.deny : [],
		loadPaths: Array.isArray(config?.loadPaths) ? config.loadPaths : [],
		entries:
			config?.entries && typeof config.entries === "object"
				? config.entries
				: {},
		slots:
			config?.slots && typeof config.slots === "object" ? config.slots : {},
	};
}

/**
 * Get the manifest cache TTL from environment.
 */
function resolveManifestCacheMs(env: NodeJS.ProcessEnv): number {
	const raw = env.ELIZAOS_PLUGIN_MANIFEST_CACHE_MS?.trim();
	if (raw === "" || raw === "0") {
		return 0;
	}
	if (!raw) {
		return DEFAULT_MANIFEST_CACHE_MS;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_MANIFEST_CACHE_MS;
	}
	return Math.max(0, parsed);
}

/**
 * Check if manifest caching should be used.
 */
function shouldUseManifestCache(env: NodeJS.ProcessEnv): boolean {
	const disabled = env.ELIZAOS_DISABLE_PLUGIN_MANIFEST_CACHE?.trim();
	if (disabled) {
		return false;
	}
	return resolveManifestCacheMs(env) > 0;
}

/**
 * Build a cache key for the registry.
 */
function buildCacheKey(params: {
	workspaceDir?: string;
	plugins: NormalizedPluginsConfig;
}): string {
	const workspaceKey = params.workspaceDir
		? resolveUserPath(params.workspaceDir)
		: "";
	return `${workspaceKey}::${JSON.stringify(params.plugins)}`;
}

/**
 * Safely get file modification time.
 */
function safeStatMtimeMs(filePath: string): number | null {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Check if a value is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Normalize a string list from manifest.
 */
function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter(Boolean);
}

/**
 * Normalize a manifest label field.
 */
function normalizeManifestLabel(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Resolve the path to a plugin's manifest file.
 */
export function resolvePluginManifestPath(rootDir: string): string {
	for (const filename of PLUGIN_MANIFEST_FILENAMES) {
		const candidate = path.join(rootDir, filename);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return path.join(rootDir, PLUGIN_MANIFEST_FILENAME);
}

/**
 * Load a plugin manifest from disk.
 *
 * @param rootDir - The plugin root directory
 * @returns Load result with manifest or error
 */
export function loadPluginManifest(rootDir: string): PluginManifestLoadResult {
	const manifestPath = resolvePluginManifestPath(rootDir);

	if (!fs.existsSync(manifestPath)) {
		return {
			ok: false,
			error: `Plugin manifest not found: ${manifestPath}`,
			manifestPath,
		};
	}

	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
	} catch (err) {
		return {
			ok: false,
			error: `Failed to parse plugin manifest: ${String(err)}`,
			manifestPath,
		};
	}

	if (!isRecord(raw)) {
		return {
			ok: false,
			error: "Plugin manifest must be an object",
			manifestPath,
		};
	}

	// Required: id
	const id = typeof raw.id === "string" ? raw.id.trim() : "";
	if (!id) {
		return {
			ok: false,
			error: "Plugin manifest requires 'id' field",
			manifestPath,
		};
	}

	// Required: configSchema
	const configSchema = isRecord(raw.configSchema) ? raw.configSchema : null;
	if (!configSchema) {
		return {
			ok: false,
			error: "Plugin manifest requires 'configSchema' field",
			manifestPath,
		};
	}

	// Optional fields
	const kind =
		typeof raw.kind === "string" ? (raw.kind as PluginKind) : undefined;
	const name = typeof raw.name === "string" ? raw.name.trim() : undefined;
	const description =
		typeof raw.description === "string" ? raw.description.trim() : undefined;
	const version =
		typeof raw.version === "string" ? raw.version.trim() : undefined;
	const channels = normalizeStringList(raw.channels);
	const providers = normalizeStringList(raw.providers);
	const skills = normalizeStringList(raw.skills);
	const gatewayMethods = normalizeStringList(raw.gatewayMethods);
	const cliCommands = normalizeStringList(raw.cliCommands);
	const requiredSecrets = normalizeStringList(raw.requiredSecrets);
	const optionalSecrets = normalizeStringList(raw.optionalSecrets);
	const dependencies = normalizeStringList(raw.dependencies);
	const keywords = normalizeStringList(raw.keywords);

	let uiHints: Record<string, PluginConfigUiHint> | undefined;
	if (isRecord(raw.uiHints)) {
		uiHints = raw.uiHints as Record<string, PluginConfigUiHint>;
	}

	const manifest: PluginManifest = {
		id,
		configSchema: configSchema as Record<string, JsonValue>,
		kind,
		channels,
		providers,
		skills,
		gatewayMethods,
		cliCommands,
		requiredSecrets,
		optionalSecrets,
		dependencies,
		keywords,
		name,
		description,
		version,
		uiHints,
		author: typeof raw.author === "string" ? raw.author.trim() : undefined,
		homepage:
			typeof raw.homepage === "string" ? raw.homepage.trim() : undefined,
		repository:
			typeof raw.repository === "string" ? raw.repository.trim() : undefined,
		license: typeof raw.license === "string" ? raw.license.trim() : undefined,
		minElizaVersion:
			typeof raw.minElizaVersion === "string"
				? raw.minElizaVersion.trim()
				: undefined,
	};

	return {
		ok: true,
		manifest,
		manifestPath,
	};
}

/**
 * Build a manifest record from a manifest and candidate.
 */
function buildRecord(params: {
	manifest: PluginManifest;
	candidate: PluginCandidate;
	manifestPath: string;
	schemaCacheKey?: string;
	configSchema?: Record<string, JsonValue>;
}): PluginManifestRecord {
	return {
		id: params.manifest.id,
		name:
			normalizeManifestLabel(params.manifest.name) ??
			params.candidate.packageName,
		description:
			normalizeManifestLabel(params.manifest.description) ??
			params.candidate.packageDescription,
		version:
			normalizeManifestLabel(params.manifest.version) ??
			params.candidate.packageVersion,
		kind: params.manifest.kind,
		channels: params.manifest.channels ?? [],
		providers: params.manifest.providers ?? [],
		skills: Array.isArray(params.manifest.skills)
			? params.manifest.skills.map((s) => (typeof s === "string" ? s : s.id))
			: [],
		origin: params.candidate.origin,
		workspaceDir: params.candidate.workspaceDir,
		rootDir: params.candidate.rootDir,
		source: params.candidate.source,
		manifestPath: params.manifestPath,
		schemaCacheKey: params.schemaCacheKey,
		configSchema: params.configSchema,
		configUiHints: params.manifest.uiHints,
	};
}

/**
 * Load the plugin manifest registry.
 *
 * Discovers all plugin candidates and loads their manifests.
 *
 * @param params - Registry loading parameters
 * @returns Plugin manifest registry
 */
export function loadPluginManifestRegistry(params: {
	config?: { plugins?: Partial<PluginsConfig> };
	workspaceDir?: string;
	cache?: boolean;
	env?: NodeJS.ProcessEnv;
	candidates?: PluginCandidate[];
	diagnostics?: PluginDiagnostic[];
}): PluginManifestRegistry {
	const config = params.config ?? {};
	const normalized = normalizePluginsConfig(config.plugins);
	const cacheKey = buildCacheKey({
		workspaceDir: params.workspaceDir,
		plugins: normalized,
	});
	const env = params.env ?? process.env;
	const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);

	// Check cache
	if (cacheEnabled) {
		const cached = registryCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.registry;
		}
	}

	// Discover plugins if not provided
	const discovery = params.candidates
		? {
				candidates: params.candidates,
				diagnostics: params.diagnostics ?? [],
			}
		: discoverPlugins({
				workspaceDir: params.workspaceDir,
				extraPaths: normalized.loadPaths,
			});

	const diagnostics: PluginDiagnostic[] = [...discovery.diagnostics];
	const candidates: PluginCandidate[] = discovery.candidates;
	const records: PluginManifestRecord[] = [];
	const seenIds = new Set<string>();

	for (const candidate of candidates) {
		const manifestRes = loadPluginManifest(candidate.rootDir);

		if (!manifestRes.ok) {
			const errRes = manifestRes as {
				ok: false;
				error: string;
				manifestPath: string;
			};
			diagnostics.push({
				level: "error",
				message: errRes.error,
				source: errRes.manifestPath,
			});
			continue;
		}

		const manifest = manifestRes.manifest;

		// Warn on ID mismatch
		if (candidate.idHint && candidate.idHint !== manifest.id) {
			diagnostics.push({
				level: "warn",
				pluginId: manifest.id,
				source: candidate.source,
				message: `Plugin ID mismatch (manifest uses "${manifest.id}", entry hints "${candidate.idHint}")`,
			});
		}

		// Warn on duplicate IDs
		if (seenIds.has(manifest.id)) {
			diagnostics.push({
				level: "warn",
				pluginId: manifest.id,
				source: candidate.source,
				message: `Duplicate plugin ID detected; later plugin may be overridden (${candidate.source})`,
			});
		} else {
			seenIds.add(manifest.id);
		}

		// Build schema cache key
		const configSchema = manifest.configSchema;
		const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
		const schemaCacheKey = manifestMtime
			? `${manifestRes.manifestPath}:${manifestMtime}`
			: manifestRes.manifestPath;

		records.push(
			buildRecord({
				manifest,
				candidate,
				manifestPath: manifestRes.manifestPath,
				schemaCacheKey,
				configSchema,
			}),
		);
	}

	const registry = { plugins: records, diagnostics };

	// Update cache
	if (cacheEnabled) {
		const ttl = resolveManifestCacheMs(env);
		if (ttl > 0) {
			registryCache.set(cacheKey, {
				expiresAt: Date.now() + ttl,
				registry,
			});
		}
	}

	return registry;
}

/**
 * Clear the manifest registry cache.
 */
export function clearManifestRegistryCache(): void {
	registryCache.clear();
}

/**
 * Get a plugin manifest record by ID.
 *
 * @param registry - The manifest registry
 * @param pluginId - The plugin ID to find
 * @returns The manifest record or undefined
 */
export function getPluginManifestById(
	registry: PluginManifestRegistry,
	pluginId: string,
): PluginManifestRecord | undefined {
	return registry.plugins.find((p) => p.id === pluginId);
}

/**
 * Get all plugins of a specific kind.
 *
 * @param registry - The manifest registry
 * @param kind - The plugin kind
 * @returns Array of matching manifest records
 */
export function getPluginsByKind(
	registry: PluginManifestRegistry,
	kind: PluginKind,
): PluginManifestRecord[] {
	return registry.plugins.filter((p) => p.kind === kind);
}

/**
 * Get all plugins that provide a specific channel.
 *
 * @param registry - The manifest registry
 * @param channelId - The channel ID
 * @returns Array of matching manifest records
 */
export function getPluginsByChannel(
	registry: PluginManifestRegistry,
	channelId: string,
): PluginManifestRecord[] {
	return registry.plugins.filter((p) => p.channels.includes(channelId));
}

/**
 * Get all plugins that provide a specific provider.
 *
 * @param registry - The manifest registry
 * @param providerId - The provider ID
 * @returns Array of matching manifest records
 */
export function getPluginsByProvider(
	registry: PluginManifestRegistry,
	providerId: string,
): PluginManifestRecord[] {
	return registry.plugins.filter((p) => p.providers.includes(providerId));
}
