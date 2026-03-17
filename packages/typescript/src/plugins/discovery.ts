/**
 * Plugin Discovery
 *
 * Discovers plugins in workspace, global, npm, and bundled locations.
 *
 * @module plugins/discovery
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	elizaOSPackageManifest,
	PackageManifest,
	PluginCandidate,
	PluginDiagnostic,
	PluginDiscoveryResult,
	PluginOrigin,
} from "../types/plugin-manifest.ts";

/** Supported extension file extensions */
const EXTENSION_EXTS = new Set([".ts", ".js", ".mts", ".cts", ".mjs", ".cjs"]);

/** Default plugin directory names */
const PLUGIN_DIR_NAMES = ["plugins", "extensions", ".elizaos/plugins"];

/** Default global config directory */
const DEFAULT_CONFIG_DIR = ".elizaos";

/**
 * Resolve the global configuration directory path.
 */
function resolveConfigDir(): string {
	const envPath = process.env.ELIZAOS_CONFIG_DIR?.trim();
	if (envPath) {
		return path.isAbsolute(envPath)
			? envPath
			: path.join(os.homedir(), envPath);
	}
	return path.join(os.homedir(), DEFAULT_CONFIG_DIR);
}

/**
 * Resolve a user path with tilde expansion.
 */
function resolveUserPath(inputPath: string): string {
	if (inputPath.startsWith("~/")) {
		return path.join(os.homedir(), inputPath.slice(2));
	}
	if (inputPath.startsWith("~")) {
		return path.join(os.homedir(), inputPath.slice(1));
	}
	return path.resolve(inputPath);
}

/**
 * Check if a file is a valid extension entry point.
 */
function isExtensionFile(filePath: string): boolean {
	const ext = path.extname(filePath);
	if (!EXTENSION_EXTS.has(ext)) {
		return false;
	}
	// Exclude TypeScript declaration files
	return !filePath.endsWith(".d.ts");
}

/**
 * Read and parse a package.json file.
 */
function readPackageManifest(dir: string): PackageManifest | null {
	const manifestPath = path.join(dir, "package.json");
	if (!fs.existsSync(manifestPath)) {
		return null;
	}
	try {
		const raw = fs.readFileSync(manifestPath, "utf-8");
		return JSON.parse(raw) as PackageManifest;
	} catch {
		return null;
	}
}

/**
 * Get elizaOS package manifest metadata from package.json.
 */
function getPackageManifestMetadata(
	manifest: PackageManifest | undefined,
): elizaOSPackageManifest | undefined {
	if (!manifest) {
		return undefined;
	}
	return manifest.elizaos;
}

/**
 * Resolve extension entry points from package manifest.
 */
function resolvePackageExtensions(manifest: PackageManifest): string[] {
	const metadata = getPackageManifestMetadata(manifest);
	const raw = metadata?.extensions;
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter(Boolean);
}

/**
 * Derive a plugin ID hint from file path and package name.
 */
function deriveIdHint(params: {
	filePath: string;
	packageName?: string;
	hasMultipleExtensions: boolean;
}): string {
	const base = path.basename(params.filePath, path.extname(params.filePath));
	const rawPackageName = params.packageName?.trim();
	if (!rawPackageName) {
		return base;
	}

	// Prefer the unscoped name so config keys stay stable even when the npm
	// package is scoped (example: @elizaos/plugin-discord -> discord)
	const unscoped = rawPackageName.includes("/")
		? (rawPackageName.split("/").pop() ?? rawPackageName)
		: rawPackageName;

	// Strip common prefixes
	const normalized = unscoped
		.replace(/^plugin-/, "")
		.replace(/^elizaos-/, "")
		.replace(/-plugin$/, "");

	if (!params.hasMultipleExtensions) {
		return normalized;
	}
	return `${normalized}/${base}`;
}

/**
 * Add a plugin candidate to the list if not already seen.
 */
function addCandidate(params: {
	candidates: PluginCandidate[];
	seen: Set<string>;
	idHint: string;
	source: string;
	rootDir: string;
	origin: PluginOrigin;
	workspaceDir?: string;
	manifest?: PackageManifest | null;
	packageDir?: string;
}): void {
	const resolved = path.resolve(params.source);
	if (params.seen.has(resolved)) {
		return;
	}
	params.seen.add(resolved);

	const manifest = params.manifest ?? null;
	params.candidates.push({
		idHint: params.idHint,
		source: resolved,
		rootDir: path.resolve(params.rootDir),
		origin: params.origin,
		workspaceDir: params.workspaceDir,
		packageName: manifest?.name?.trim() || undefined,
		packageVersion: manifest?.version?.trim() || undefined,
		packageDescription: manifest?.description?.trim() || undefined,
		packageDir: params.packageDir,
		packageManifest: getPackageManifestMetadata(manifest ?? undefined),
	});
}

/**
 * Discover plugins in a directory.
 */
function discoverInDirectory(params: {
	dir: string;
	origin: PluginOrigin;
	workspaceDir?: string;
	candidates: PluginCandidate[];
	diagnostics: PluginDiagnostic[];
	seen: Set<string>;
}): void {
	if (!fs.existsSync(params.dir)) {
		return;
	}

	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(params.dir, { withFileTypes: true });
	} catch (err) {
		params.diagnostics.push({
			level: "warn",
			message: `Failed to read plugins directory: ${params.dir} (${String(err)})`,
			source: params.dir,
		});
		return;
	}

	for (const entry of entries) {
		const fullPath = path.join(params.dir, entry.name);

		// Handle direct extension files
		if (entry.isFile()) {
			if (!isExtensionFile(fullPath)) {
				continue;
			}
			addCandidate({
				candidates: params.candidates,
				seen: params.seen,
				idHint: path.basename(entry.name, path.extname(entry.name)),
				source: fullPath,
				rootDir: path.dirname(fullPath),
				origin: params.origin,
				workspaceDir: params.workspaceDir,
			});
			continue;
		}

		if (!entry.isDirectory()) {
			continue;
		}

		// Handle plugin packages (directories with package.json)
		const manifest = readPackageManifest(fullPath);
		const extensions = manifest ? resolvePackageExtensions(manifest) : [];

		// If package.json specifies extensions, use those
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const resolved = path.resolve(fullPath, extPath);
				addCandidate({
					candidates: params.candidates,
					seen: params.seen,
					idHint: deriveIdHint({
						filePath: resolved,
						packageName: manifest?.name,
						hasMultipleExtensions: extensions.length > 1,
					}),
					source: resolved,
					rootDir: fullPath,
					origin: params.origin,
					workspaceDir: params.workspaceDir,
					manifest,
					packageDir: fullPath,
				});
			}
			continue;
		}

		// Look for index files
		const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
		const indexFile = indexCandidates
			.map((candidate) => path.join(fullPath, candidate))
			.find((candidate) => fs.existsSync(candidate));

		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates: params.candidates,
				seen: params.seen,
				idHint: entry.name,
				source: indexFile,
				rootDir: fullPath,
				origin: params.origin,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: fullPath,
			});
		}
	}
}

/**
 * Discover plugins from a specific path.
 */
function discoverFromPath(params: {
	rawPath: string;
	origin: PluginOrigin;
	workspaceDir?: string;
	candidates: PluginCandidate[];
	diagnostics: PluginDiagnostic[];
	seen: Set<string>;
}): void {
	const resolved = resolveUserPath(params.rawPath);
	if (!fs.existsSync(resolved)) {
		params.diagnostics.push({
			level: "error",
			message: `Plugin path not found: ${resolved}`,
			source: resolved,
		});
		return;
	}

	const stat = fs.statSync(resolved);

	// Handle direct file paths
	if (stat.isFile()) {
		if (!isExtensionFile(resolved)) {
			params.diagnostics.push({
				level: "error",
				message: `Plugin path is not a supported file type: ${resolved}`,
				source: resolved,
			});
			return;
		}
		addCandidate({
			candidates: params.candidates,
			seen: params.seen,
			idHint: path.basename(resolved, path.extname(resolved)),
			source: resolved,
			rootDir: path.dirname(resolved),
			origin: params.origin,
			workspaceDir: params.workspaceDir,
		});
		return;
	}

	// Handle directory paths
	if (stat.isDirectory()) {
		const manifest = readPackageManifest(resolved);
		const extensions = manifest ? resolvePackageExtensions(manifest) : [];

		// If package.json specifies extensions, use those
		if (extensions.length > 0) {
			for (const extPath of extensions) {
				const source = path.resolve(resolved, extPath);
				addCandidate({
					candidates: params.candidates,
					seen: params.seen,
					idHint: deriveIdHint({
						filePath: source,
						packageName: manifest?.name,
						hasMultipleExtensions: extensions.length > 1,
					}),
					source,
					rootDir: resolved,
					origin: params.origin,
					workspaceDir: params.workspaceDir,
					manifest,
					packageDir: resolved,
				});
			}
			return;
		}

		// Look for index files
		const indexCandidates = ["index.ts", "index.js", "index.mjs", "index.cjs"];
		const indexFile = indexCandidates
			.map((candidate) => path.join(resolved, candidate))
			.find((candidate) => fs.existsSync(candidate));

		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates: params.candidates,
				seen: params.seen,
				idHint: path.basename(resolved),
				source: indexFile,
				rootDir: resolved,
				origin: params.origin,
				workspaceDir: params.workspaceDir,
				manifest,
				packageDir: resolved,
			});
			return;
		}

		// Scan directory for plugins
		discoverInDirectory({
			dir: resolved,
			origin: params.origin,
			workspaceDir: params.workspaceDir,
			candidates: params.candidates,
			diagnostics: params.diagnostics,
			seen: params.seen,
		});
	}
}

/**
 * Resolve the bundled plugins directory.
 * This looks for plugins bundled with the elizaOS installation.
 */
function resolveBundledPluginsDir(): string | null {
	try {
		// Look relative to this module's location
		const moduleDir = path.dirname(new URL(import.meta.url).pathname);

		// Check various locations relative to the package
		const candidates = [
			path.join(moduleDir, "..", "..", "plugins"),
			path.join(moduleDir, "..", "..", "..", "plugins"),
			path.join(moduleDir, "..", "..", "bundled-plugins"),
		];

		for (const candidate of candidates) {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
				return candidate;
			}
		}
	} catch {
		// Ignore errors - bundled plugins are optional
	}
	return null;
}

/**
 * Discover all elizaOS plugins.
 *
 * Search order (first match wins for duplicate IDs):
 * 1. Extra paths from config
 * 2. Workspace plugins directory
 * 3. Global plugins directory
 * 4. Bundled plugins
 *
 * @param params - Discovery parameters
 * @returns Discovery result with candidates and diagnostics
 */
export function discoverPlugins(params: {
	workspaceDir?: string;
	extraPaths?: string[];
}): PluginDiscoveryResult {
	const candidates: PluginCandidate[] = [];
	const diagnostics: PluginDiagnostic[] = [];
	const seen = new Set<string>();
	const workspaceDir = params.workspaceDir?.trim();

	// 1. Process extra paths from config
	const extra = params.extraPaths ?? [];
	for (const extraPath of extra) {
		if (typeof extraPath !== "string") {
			continue;
		}
		const trimmed = extraPath.trim();
		if (!trimmed) {
			continue;
		}
		discoverFromPath({
			rawPath: trimmed,
			origin: "config",
			workspaceDir: workspaceDir?.trim() || undefined,
			candidates,
			diagnostics,
			seen,
		});
	}

	// 2. Scan workspace plugins directories
	if (workspaceDir) {
		const workspaceRoot = resolveUserPath(workspaceDir);
		for (const dirName of PLUGIN_DIR_NAMES) {
			const dir = path.join(workspaceRoot, dirName);
			discoverInDirectory({
				dir,
				origin: "workspace",
				workspaceDir: workspaceRoot,
				candidates,
				diagnostics,
				seen,
			});
		}
	}

	// 3. Scan global plugins directory
	const globalDir = path.join(resolveConfigDir(), "plugins");
	discoverInDirectory({
		dir: globalDir,
		origin: "global",
		candidates,
		diagnostics,
		seen,
	});

	// 4. Scan bundled plugins directory
	const bundledDir = resolveBundledPluginsDir();
	if (bundledDir) {
		discoverInDirectory({
			dir: bundledDir,
			origin: "bundled",
			candidates,
			diagnostics,
			seen,
		});
	}

	return { candidates, diagnostics };
}

/**
 * Discover plugins in npm node_modules.
 * Looks for packages with elizaos.plugin.json or elizaos metadata in package.json.
 *
 * @param nodeModulesDir - Path to node_modules directory
 * @returns Discovery result with candidates and diagnostics
 */
export function discoverNpmPlugins(
	nodeModulesDir: string,
): PluginDiscoveryResult {
	const candidates: PluginCandidate[] = [];
	const diagnostics: PluginDiagnostic[] = [];
	const seen = new Set<string>();

	if (!fs.existsSync(nodeModulesDir)) {
		return { candidates, diagnostics };
	}

	let entries: fs.Dirent[] = [];
	try {
		entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
	} catch (err) {
		diagnostics.push({
			level: "warn",
			message: `Failed to read node_modules: ${nodeModulesDir} (${String(err)})`,
			source: nodeModulesDir,
		});
		return { candidates, diagnostics };
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		// Handle scoped packages (@scope/package)
		if (entry.name.startsWith("@")) {
			const scopeDir = path.join(nodeModulesDir, entry.name);
			let scopeEntries: fs.Dirent[] = [];
			try {
				scopeEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
			} catch {
				continue;
			}

			for (const scopeEntry of scopeEntries) {
				if (!scopeEntry.isDirectory()) {
					continue;
				}
				const packageDir = path.join(scopeDir, scopeEntry.name);
				checkNpmPackage(packageDir, candidates, diagnostics, seen);
			}
		} else {
			const packageDir = path.join(nodeModulesDir, entry.name);
			checkNpmPackage(packageDir, candidates, diagnostics, seen);
		}
	}

	return { candidates, diagnostics };
}

/**
 * Check if an npm package is an elizaOS plugin.
 */
function checkNpmPackage(
	packageDir: string,
	candidates: PluginCandidate[],
	_diagnostics: PluginDiagnostic[],
	seen: Set<string>,
): void {
	const manifest = readPackageManifest(packageDir);
	if (!manifest) {
		return;
	}

	// Check if it's a plugin (has elizaos metadata or plugin manifest)
	const metadata = getPackageManifestMetadata(manifest);
	const hasPluginManifest = fs.existsSync(
		path.join(packageDir, "elizaos.plugin.json"),
	);

	if (!metadata && !hasPluginManifest) {
		return;
	}

	const extensions = metadata?.extensions ?? [];

	if (extensions.length > 0) {
		for (const extPath of extensions) {
			const source = path.resolve(packageDir, extPath);
			addCandidate({
				candidates,
				seen,
				idHint: deriveIdHint({
					filePath: source,
					packageName: manifest.name,
					hasMultipleExtensions: extensions.length > 1,
				}),
				source,
				rootDir: packageDir,
				origin: "npm",
				manifest,
				packageDir,
			});
		}
	} else {
		// Look for index files
		const indexCandidates = [
			"index.ts",
			"index.js",
			"index.mjs",
			"index.cjs",
			"dist/index.js",
		];
		const indexFile = indexCandidates
			.map((candidate) => path.join(packageDir, candidate))
			.find((candidate) => fs.existsSync(candidate));

		if (indexFile && isExtensionFile(indexFile)) {
			addCandidate({
				candidates,
				seen,
				idHint: deriveIdHint({
					filePath: indexFile,
					packageName: manifest.name,
					hasMultipleExtensions: false,
				}),
				source: indexFile,
				rootDir: packageDir,
				origin: "npm",
				manifest,
				packageDir,
			});
		}
	}
}

export {
	deriveIdHint,
	getPackageManifestMetadata,
	isExtensionFile,
	readPackageManifest,
	resolveConfigDir,
	resolveUserPath,
};
