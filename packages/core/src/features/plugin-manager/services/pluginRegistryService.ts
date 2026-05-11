import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { logger } from "../../../logger.ts";
import type { PluginMetadata } from "../types.ts";

// ---------------------------------------------------------------------------
// Registry URLs
// ---------------------------------------------------------------------------

const GENERATED_REGISTRY_URL =
	"https://plugins.elizacloud.ai/generated-registry.json";
const INDEX_REGISTRY_URL = "https://plugins.elizacloud.ai/index.json";

const CACHE_DURATION = 3_600_000; // 1 hour

// ---------------------------------------------------------------------------
// Local plugins directory (relative to cwd)
// ---------------------------------------------------------------------------

const LOCAL_PLUGINS_DIR = "plugins";
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Wire types for the generated-registry.json format
// ---------------------------------------------------------------------------

interface GeneratedRegistryEntry {
	git: {
		repo: string;
		v0: { version: string | null; branch: string | null };
		v1: { version: string | null; branch: string | null };
		v2: { version: string | null; branch: string | null };
	};
	npm: {
		repo: string;
		v0: string | null;
		v1: string | null;
		v2: string | null;
		v0CoreRange: string | null;
		v1CoreRange: string | null;
		v2CoreRange: string | null;
	};
	supports: { v0: boolean; v1: boolean; v2: boolean };
	description: string;
	homepage: string | null;
	topics: string[];
	stargazers_count: number;
	language: string;
	origin?: string;
	source?: string;
	support?: string;
	builtIn?: boolean;
	firstParty?: boolean;
	thirdParty?: boolean;
	status?: string;
	kind?: string;
	registryKind?: string;
	directory?: string | null;
	app?: {
		displayName?: string;
		category?: string;
		launchType?: "connect" | "local" | "url" | "overlay" | string;
		launchUrl?: string | null;
		icon?: string | null;
		capabilities?: string[];
		viewer?: {
			url: string;
			embedParams?: Record<string, string>;
			postMessageAuth?: boolean;
			sandbox?: string;
		};
	};
}

interface GeneratedRegistryFile {
	lastUpdatedAt: string;
	registry: Record<string, GeneratedRegistryEntry>;
	apps?: Record<string, GeneratedRegistryEntry>;
}

// ---------------------------------------------------------------------------
// Normalised plugin representation
// ---------------------------------------------------------------------------

export interface RegistryPlugin {
	name: string;
	gitRepo: string;
	gitUrl: string;
	directory?: string | null;
	description: string;
	homepage: string | null;
	topics: string[];
	stars: number;
	language: string;
	npm: {
		package: string;
		v0Version: string | null;
		v1Version: string | null;
		v2Version: string | null;
		v0CoreRange: string | null;
		v1CoreRange: string | null;
		v2CoreRange: string | null;
	};
	git: {
		v0Branch: string | null;
		v1Branch: string | null;
		v2Branch: string | null;
	};
	supports: { v0: boolean; v1: boolean; v2: boolean };
	// App/Viewer extensions
	viewer?: {
		url: string;
		embedParams?: Record<string, string>;
		postMessageAuth?: boolean;
		sandbox?: string;
	};
	launchType?: "connect" | "local" | "url" | "overlay" | string;
	launchUrl?: string;
	displayName?: string;
	kind?: string;
	// App-specific metadata
	category?: string;
	capabilities?: string[];
	icon?: string | null;
	registryKind?: string;
	origin?: "builtin" | "third-party" | string;
	source?: string;
	support?: "first-party" | "community" | string;
	builtIn?: boolean;
	firstParty?: boolean;
	thirdParty?: boolean;
	status?: string;
}

export interface PluginSearchResult {
	name: string;
	description: string;
	score: number;
	tags: string[];
	version: string | null;
	npmPackage: string;
	repository: string;
	stars: number;
	supports: { v0: boolean; v1: boolean; v2: boolean };
}

export interface CloneResult {
	success: boolean;
	error?: string;
	pluginName?: string;
	localPath?: string;
	hasTests?: boolean;
	dependencies?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

let registryCache: {
	plugins: Map<string, RegistryPlugin>;
	timestamp: number;
} | null = null;

export function resetRegistryCache(): void {
	registryCache = null;
}

// ---------------------------------------------------------------------------
// Fetching & parsing
// ---------------------------------------------------------------------------

function entryToPlugin(
	name: string,
	e: GeneratedRegistryEntry & { kind?: string },
): RegistryPlugin {
	return {
		name,
		gitRepo: e.git.repo,
		gitUrl: `https://github.com/${e.git.repo}.git`,
		directory: e.directory ?? null,
		description: e.description || "",
		homepage: e.homepage,
		topics: e.topics || [],
		stars: e.stargazers_count || 0,
		language: e.language || "TypeScript",
		npm: {
			package: e.npm.repo,
			v0Version: e.npm.v0,
			v1Version: e.npm.v1,
			v2Version: e.npm.v2,
			v0CoreRange: e.npm.v0CoreRange,
			v1CoreRange: e.npm.v1CoreRange,
			v2CoreRange: e.npm.v2CoreRange,
		},
		git: {
			v0Branch: e.git.v0?.branch ?? null,
			v1Branch: e.git.v1?.branch ?? null,
			v2Branch: e.git.v2?.branch ?? null,
		},
		supports: e.supports,
		kind: e.kind,
		registryKind: e.registryKind,
		origin: e.origin,
		source: e.source,
		support: e.support,
		builtIn: e.builtIn,
		firstParty: e.firstParty,
		thirdParty: e.thirdParty,
		status: e.status,
		displayName: e.app?.displayName,
		category: e.app?.category,
		launchType: e.app?.launchType,
		launchUrl: e.app?.launchUrl ?? undefined,
		icon: e.app?.icon,
		capabilities: e.app?.capabilities,
		viewer: e.app?.viewer,
	};
}

function stubPlugin(name: string, gitRef: string): RegistryPlugin {
	const repo = gitRef.replace(/^github:/, "");
	const isBuiltIn = name.startsWith("@elizaos/");
	return {
		name,
		gitRepo: repo,
		gitUrl: `https://github.com/${repo}.git`,
		directory: null,
		description: "",
		homepage: null,
		topics: [],
		stars: 0,
		language: "TypeScript",
		npm: {
			package: name,
			v0Version: null,
			v1Version: null,
			v2Version: null,
			v0CoreRange: null,
			v1CoreRange: null,
			v2CoreRange: null,
		},
		git: { v0Branch: null, v1Branch: null, v2Branch: "next" },
		supports: { v0: false, v1: false, v2: false },
		origin: isBuiltIn ? "builtin" : "third-party",
		source: isBuiltIn ? "builtin" : "third-party",
		support: isBuiltIn ? "first-party" : "community",
		builtIn: isBuiltIn,
		firstParty: isBuiltIn,
		thirdParty: !isBuiltIn,
	};
}

// ---------------------------------------------------------------------------
// Local plugin discovery - scans plugins/ for elizaos.plugin.json files
// ---------------------------------------------------------------------------

interface LocalPluginJson {
	id?: string;
	name?: string;
	description?: string;
	version?: string;
	kind?: string;
	app?: {
		displayName?: string;
		category?: string;
		launchType?: "connect" | "local";
		launchUrl?: string;
		capabilities?: string[];
	};
	viewer?: {
		url: string;
		embedParams?: Record<string, string>;
		postMessageAuth?: boolean;
		sandbox?: string;
	};
	configSchema?: Record<string, unknown>;
	keywords?: string[];
	author?: string;
	homepage?: string;
	repository?: string;
}

function localPluginToRegistry(
	pluginJson: LocalPluginJson,
	dirName: string,
): RegistryPlugin {
	const name = pluginJson.id || `@elizaos/${dirName}`;
	const displayName = pluginJson.app?.displayName || pluginJson.name || dirName;
	const description = pluginJson.description || "";
	const homepage = pluginJson.homepage || null;
	const keywords = pluginJson.keywords || [];
	const repo =
		pluginJson.repository
			?.replace("https://github.com/", "")
			.replace(".git", "") || `elizaos/${dirName}`;

	return {
		name,
		gitRepo: repo,
		gitUrl: pluginJson.repository || `https://github.com/${repo}.git`,
		description,
		displayName,
		homepage,
		topics: keywords,
		stars: 0,
		language: "TypeScript",
		npm: {
			package: name,
			v0Version: null,
			v1Version: pluginJson.version || null,
			v2Version: pluginJson.version || null,
			v0CoreRange: null,
			v1CoreRange: null,
			v2CoreRange: null,
		},
		git: { v0Branch: null, v1Branch: null, v2Branch: "main" },
		supports: { v0: false, v1: true, v2: true },
		kind: pluginJson.kind,
		launchType: pluginJson.app?.launchType,
		launchUrl: pluginJson.app?.launchUrl,
		viewer: pluginJson.viewer,
		// App-specific metadata
		category: pluginJson.app?.category,
		capabilities: pluginJson.app?.capabilities || [],
		icon: null,
	};
}

async function scanLocalPlugins(): Promise<Map<string, RegistryPlugin>> {
	const plugins = new Map<string, RegistryPlugin>();
	const pluginsDir = path.resolve(process.cwd(), LOCAL_PLUGINS_DIR);

	if (!fs.existsSync(pluginsDir)) {
		return plugins;
	}

	try {
		const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const pluginJsonPath = path.join(
				pluginsDir,
				entry.name,
				"elizaos.plugin.json",
			);
			if (!fs.existsSync(pluginJsonPath)) continue;

			try {
				const content = fs.readFileSync(pluginJsonPath, "utf-8");
				const pluginJson = JSON.parse(content) as LocalPluginJson;
				const plugin = localPluginToRegistry(pluginJson, entry.name);
				plugins.set(plugin.name, plugin);
				logger.debug(
					`[registry] Found local plugin: ${plugin.name} (${entry.name})`,
				);
			} catch (err) {
				logger.warn(
					`[registry] Failed to parse ${pluginJsonPath}: ${errMsg(err)}`,
				);
			}
		}

		if (plugins.size > 0) {
			logger.info(
				`[registry] Loaded ${plugins.size} local plugins from ${pluginsDir}`,
			);
		}
	} catch (err) {
		logger.warn(`[registry] Failed to scan local plugins: ${errMsg(err)}`);
	}

	return plugins;
}

async function fetchGeneratedRegistry(): Promise<Map<string, RegistryPlugin>> {
	const response = await fetch(GENERATED_REGISTRY_URL);
	if (!response.ok) {
		throw new Error(
			`generated-registry.json: ${response.status} ${response.statusText}`,
		);
	}
	const data = (await response.json()) as GeneratedRegistryFile;
	const plugins = new Map<string, RegistryPlugin>();
	for (const [name, entry] of Object.entries(data.registry)) {
		plugins.set(name, entryToPlugin(name, entry));
	}
	if (data.apps) {
		for (const [name, entry] of Object.entries(data.apps)) {
			plugins.set(name, entryToPlugin(name, { ...entry, kind: "app" }));
		}
	}
	return plugins;
}

async function fetchIndexRegistry(): Promise<Map<string, RegistryPlugin>> {
	const response = await fetch(INDEX_REGISTRY_URL);
	if (!response.ok) {
		throw new Error(`index.json: ${response.status} ${response.statusText}`);
	}
	const data = (await response.json()) as Record<string, string>;
	const plugins = new Map<string, RegistryPlugin>();
	for (const [name, gitRef] of Object.entries(data)) {
		plugins.set(name, stubPlugin(name, gitRef));
	}
	return plugins;
}

/**
 * Load the plugin registry from the next@registry branch.
 * Tries generated-registry.json first, falls back to index.json.
 * Also scans local plugins/ directory for elizaos.plugin.json files.
 * Local plugins override remote registry entries.
 * Cached in-memory for 1 hour.
 */
export async function loadRegistry(): Promise<Map<string, RegistryPlugin>> {
	if (registryCache && Date.now() - registryCache.timestamp < CACHE_DURATION) {
		return registryCache.plugins;
	}

	logger.info("[registry] Fetching from next@registry...");

	let plugins: Map<string, RegistryPlugin> = new Map();
	try {
		plugins = await fetchGeneratedRegistry();
		logger.info(
			`[registry] Loaded ${plugins.size} plugins (generated-registry.json)`,
		);
	} catch (err) {
		logger.warn(
			`[registry] generated-registry.json unavailable: ${errMsg(err)}, falling back to index.json`,
		);
		try {
			plugins = await fetchIndexRegistry();
			logger.info(`[registry] Loaded ${plugins.size} plugins (index.json)`);
		} catch (err2) {
			logger.warn(
				`[registry] index.json also unavailable: ${errMsg(err2)}, using local plugins only`,
			);
			// Continue with empty remote registry - local plugins will still be added
		}
	}

	// Merge local plugins (they override remote registry entries)
	const localPlugins = await scanLocalPlugins();
	for (const [name, plugin] of localPlugins) {
		plugins.set(name, plugin);
	}

	registryCache = { plugins, timestamp: Date.now() };
	return plugins;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Resolve a plugin by name with fuzzy matching (exact -> @elizaos/ prefix -> bare name). */
function resolvePlugin(
	registry: Map<string, RegistryPlugin>,
	name: string,
): RegistryPlugin | null {
	let p = registry.get(name);
	if (p) return p;

	if (!name.startsWith("@")) {
		p = registry.get(`@elizaos/${name}`);
		if (p) return p;
	}

	const bare = name.replace(/^@[^/]+\//, "");
	for (const [key, value] of registry) {
		if (key.endsWith(`/${bare}`) || key === bare) return value;
	}

	return null;
}

export async function getRegistryEntry(
	name: string,
): Promise<RegistryPlugin | null> {
	return resolvePlugin(await loadRegistry(), name);
}

// ---------------------------------------------------------------------------
// RegistryPlugin -> PluginMetadata conversion
// ---------------------------------------------------------------------------

function toMetadata(p: RegistryPlugin): PluginMetadata {
	const author = p.gitRepo.split("/")[0] || "unknown";
	return {
		name: p.name,
		description: p.description,
		author,
		repository: `https://github.com/${p.gitRepo}`,
		versions: [p.npm.v0Version, p.npm.v1Version, p.npm.v2Version].filter(
			(v): v is string => v !== null,
		),
		latestVersion:
			p.npm.v2Version || p.npm.v1Version || p.npm.v0Version || "unknown",
		runtimeVersion: p.supports.v2 ? "v2" : p.supports.v1 ? "v1" : "v0",
		maintainer: author,
		tags: p.topics,
		categories: [],
	};
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function computeSearchScore(plugin: RegistryPlugin, query: string): number {
	const lq = query.toLowerCase();
	const terms = lq.split(/\s+/).filter((t) => t.length > 1);
	const ln = plugin.name.toLowerCase();
	const ld = plugin.description.toLowerCase();

	let score = 0;

	if (ln === lq || ln === `@elizaos/${lq}`) score += 100;
	else if (ln.includes(lq)) score += 50;

	if (ld.includes(lq)) score += 30;
	for (const t of plugin.topics) if (t.toLowerCase().includes(lq)) score += 25;

	for (const term of terms) {
		if (ln.includes(term)) score += 15;
		if (ld.includes(term)) score += 10;
		for (const t of plugin.topics)
			if (t.toLowerCase().includes(term)) score += 8;
	}

	// Popularity bonus only when there's already a text match
	if (score > 0) {
		if (plugin.stars > 100) score += 5;
		if (plugin.stars > 500) score += 5;
		if (plugin.stars > 1000) score += 5;
	}

	return score;
}

export async function searchPluginsByContent(
	query: string,
	limit = 10,
): Promise<PluginSearchResult[]> {
	const registry = await loadRegistry();
	const scored: Array<{ plugin: RegistryPlugin; score: number }> = [];

	for (const plugin of registry.values()) {
		const score = computeSearchScore(plugin, query);
		if (score > 0) scored.push({ plugin, score });
	}

	scored.sort((a, b) => b.score - a.score || b.plugin.stars - a.plugin.stars);
	const maxScore = scored[0]?.score || 1;

	return scored.slice(0, limit).map(({ plugin, score }) => ({
		name: plugin.name,
		description: plugin.description,
		score: score / maxScore,
		tags: plugin.topics,
		version:
			plugin.npm.v2Version || plugin.npm.v1Version || plugin.npm.v0Version,
		npmPackage: plugin.npm.package,
		repository: `https://github.com/${plugin.gitRepo}`,
		stars: plugin.stars,
		supports: plugin.supports,
	}));
}

export async function getPluginDetails(
	name: string,
): Promise<PluginMetadata | null> {
	const plugin = resolvePlugin(await loadRegistry(), name);
	return plugin ? toMetadata(plugin) : null;
}

export async function getAllPlugins(): Promise<PluginMetadata[]> {
	const registry = await loadRegistry();
	return Array.from(registry.values(), toMetadata);
}

// ---------------------------------------------------------------------------
// Legacy support for non-app plugins
// ---------------------------------------------------------------------------

export async function listNonAppPlugins(): Promise<RegistryPlugin[]> {
	const registry = await loadRegistry();
	return Array.from(registry.values()).filter(
		(p) => p.kind !== "app" && !p.displayName,
	);
}

export async function searchNonAppPlugins(
	query: string,
	limit = 10,
): Promise<PluginSearchResult[]> {
	const registry = await loadRegistry();
	const scored: Array<{ plugin: RegistryPlugin; score: number }> = [];

	for (const plugin of registry.values()) {
		if (plugin.kind === "app" || plugin.displayName) continue;
		const score = computeSearchScore(plugin, query);
		if (score > 0) scored.push({ plugin, score });
	}

	scored.sort((a, b) => b.score - a.score || b.plugin.stars - a.plugin.stars);
	const maxScore = scored[0]?.score || 1;

	return scored.slice(0, limit).map(({ plugin, score }) => ({
		name: plugin.name,
		description: plugin.description,
		score: score / maxScore,
		tags: plugin.topics,
		version:
			plugin.npm.v2Version || plugin.npm.v1Version || plugin.npm.v0Version,
		npmPackage: plugin.npm.package,
		repository: `https://github.com/${plugin.gitRepo}`,
		stars: plugin.stars,
		supports: plugin.supports,
	}));
}

export async function refreshRegistry(): Promise<Map<string, RegistryPlugin>> {
	resetRegistryCache();
	return loadRegistry();
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export async function clonePlugin(pluginName: string): Promise<CloneResult> {
	logger.info(`[registry] Cloning plugin: ${pluginName}`);

	const plugin = resolvePlugin(await loadRegistry(), pluginName);
	if (!plugin) {
		return {
			success: false,
			error: `Plugin "${pluginName}" not found in registry`,
		};
	}

	const cloneDir = path.join(
		process.cwd(),
		"cloned-plugins",
		plugin.name.replace(/^@[^/]+\//, ""),
	);
	await fs.promises.mkdir(cloneDir, { recursive: true });

	const branch = plugin.git.v2Branch || plugin.git.v1Branch || "next";
	await execFileAsync("git", [
		"clone",
		"--branch",
		branch,
		"--single-branch",
		"--depth",
		"1",
		plugin.gitUrl,
		cloneDir,
	]);

	let hasTests = false;
	let dependencies: Record<string, string> = {};
	try {
		const pkg = JSON.parse(
			await fs.promises.readFile(path.join(cloneDir, "package.json"), "utf-8"),
		) as {
			scripts?: Record<string, string>;
			devDependencies?: Record<string, string>;
			dependencies?: Record<string, string>;
		};
		hasTests = !!(pkg.scripts?.test || pkg.devDependencies?.vitest);
		dependencies = pkg.dependencies || {};
	} catch {
		logger.warn(`[registry] No package.json at repo root for ${plugin.name}`);
	}

	return {
		success: true,
		pluginName: plugin.name,
		localPath: cloneDir,
		hasTests,
		dependencies,
	};
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
