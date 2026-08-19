/**
 * Registry data layer for the plugin-manager capability: fetches and normalizes
 * the elizaOS plugin registry. Pulls the authoritative generated registry from
 * plugins.eliza.app, scans the local
 * `plugins/` directory for `elizaos.plugin.json` manifests that override remote
 * entries, and caches the merged `Map<name, RegistryPlugin>` in memory for one
 * hour. Exposes the lookup (`getRegistryEntry`, with fuzzy `@elizaos/`-prefix
 * resolution), content-scored search, metadata conversion, and clone helpers
 * that `PluginManagerService` builds its install/eject flows on top of.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { ElizaError } from "../../../errors.ts";
import { logger } from "../../../logger.ts";
import type { PluginMetadata } from "../types.ts";

// ---------------------------------------------------------------------------
// Registry URLs
// ---------------------------------------------------------------------------

const GENERATED_REGISTRY_URL =
	"https://plugins.eliza.app/generated-registry.json";
const PLUGIN_REGISTRY_FETCH_TIMEOUT_MS = 10_000;
const CACHE_DURATION = 3_600_000; // 1 hour

// ---------------------------------------------------------------------------
// Local plugins directory (relative to cwd)
// ---------------------------------------------------------------------------

const LOCAL_PLUGINS_DIR = "plugins";
// Guarded for edge isolates: the child_process builtin is absent there, and
// promisify(undefined) at module scope would kill the whole import. Node hosts
// get the real promisified binding; edge paths fail at use instead.
const execFileAsync =
	typeof execFile === "function" ? promisify(execFile) : (undefined as never);

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
			v0Branch: e.git.v0.branch ?? null,
			v1Branch: e.git.v1.branch ?? null,
			v2Branch: e.git.v2.branch ?? null,
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
		} catch (error) {
			// error-policy:J2 identify the invalid local manifest and preserve its cause
			throw new ElizaError("Failed to load local plugin manifest", {
				code: "PLUGIN_REGISTRY_LOCAL_MANIFEST_INVALID",
				cause: error,
				context: { pluginJsonPath },
			});
		}
	}

	if (plugins.size > 0) {
		logger.info(
			`[registry] Loaded ${plugins.size} local plugins from ${pluginsDir}`,
		);
	}

	return plugins;
}

function isTimeoutError(err: unknown): boolean {
	if (err instanceof DOMException) return err.name === "TimeoutError";
	if (err instanceof Error) {
		if (err.name === "TimeoutError") return true;
		// Node fetch may wrap the abort reason as cause
		const cause = (err as Error & { cause?: unknown }).cause;
		if (cause instanceof DOMException && cause.name === "TimeoutError")
			return true;
		if (cause instanceof Error && (cause as Error).name === "TimeoutError")
			return true;
	}
	return false;
}

function isAbortError(err: unknown): boolean {
	return (
		(err instanceof DOMException || err instanceof Error) &&
		err.name === "AbortError"
	);
}

async function fetchGeneratedRegistry(): Promise<Map<string, RegistryPlugin>> {
	const signal = AbortSignal.timeout(PLUGIN_REGISTRY_FETCH_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(GENERATED_REGISTRY_URL, { signal });
	} catch (err) {
		// error-policy:J2 translate the internal deadline and preserve other causes
		if (isTimeoutError(signal.reason) || isTimeoutError(err)) {
			throw new ElizaError(
				`Plugin registry fetch timed out after ${PLUGIN_REGISTRY_FETCH_TIMEOUT_MS}ms`,
				{
					code: "PLUGIN_REGISTRY_FETCH_TIMEOUT",
					cause: err,
					context: {
						timeoutMs: PLUGIN_REGISTRY_FETCH_TIMEOUT_MS,
						url: GENERATED_REGISTRY_URL,
					},
					severity: "ephemeral",
				},
			);
		}
		throw err;
	}

	if (!response.ok) {
		throw new ElizaError("Plugin registry request failed", {
			code: "PLUGIN_REGISTRY_FETCH_HTTP_ERROR",
			context: {
				status: response.status,
				statusText: response.statusText,
				url: GENERATED_REGISTRY_URL,
			},
			severity: "ephemeral",
		});
	}

	let data: GeneratedRegistryFile;
	try {
		data = (await response.json()) as GeneratedRegistryFile;
	} catch (err) {
		// error-policy:J2 distinguish the internal deadline from malformed data
		if (isTimeoutError(signal.reason) || isTimeoutError(err)) {
			throw new ElizaError(
				`Plugin registry fetch timed out after ${PLUGIN_REGISTRY_FETCH_TIMEOUT_MS}ms`,
				{
					code: "PLUGIN_REGISTRY_FETCH_TIMEOUT",
					cause: err,
					context: {
						timeoutMs: PLUGIN_REGISTRY_FETCH_TIMEOUT_MS,
						url: GENERATED_REGISTRY_URL,
					},
					severity: "ephemeral",
				},
			);
		}
		if (isAbortError(err)) throw err;
		throw new ElizaError("Plugin registry response was not valid JSON", {
			code: "PLUGIN_REGISTRY_RESPONSE_INVALID",
			cause: err,
			context: { url: GENERATED_REGISTRY_URL },
		});
	}
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

/**
 * Load the plugin registry from the next@registry branch.
 * Also scans local plugins/ directory for elizaos.plugin.json files.
 * Local plugins override remote registry entries.
 * Cached in-memory for 1 hour.
 */
export async function loadRegistry(): Promise<Map<string, RegistryPlugin>> {
	if (registryCache && Date.now() - registryCache.timestamp < CACHE_DURATION) {
		return registryCache.plugins;
	}

	logger.info("[registry] Fetching from next@registry...");

	const plugins = await fetchGeneratedRegistry();
	logger.info(
		`[registry] Loaded ${plugins.size} plugins (generated-registry.json)`,
	);

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

	const pkg = JSON.parse(
		await fs.promises.readFile(path.join(cloneDir, "package.json"), "utf-8"),
	) as {
		scripts?: Record<string, string>;
		devDependencies?: Record<string, string>;
		dependencies?: Record<string, string>;
	};
	const hasTests = Boolean(pkg.scripts?.test || pkg.devDependencies?.vitest);
	const dependencies = pkg.dependencies ?? {};

	return {
		success: true,
		pluginName: plugin.name,
		localPath: cloneDir,
		hasTests,
		dependencies,
	};
}
