#!/usr/bin/env bun

/**
 * Dual build script for @elizaos/core - generates both Node.js and browser builds
 */

import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { join } from "node:path";
import type { BuildConfig, BunPlugin } from "bun";

export interface ElizaBuildOptions {
	/** Package root directory */
	root?: string;
	/** Entry points - defaults to ['src/index.ts'] */
	entrypoints?: string[];
	/** Output directory - defaults to 'dist' */
	outdir?: string;
	/** Target environment - defaults to 'node' for packages */
	target?: "node" | "bun" | "browser";
	/** External dependencies */
	external?: string[];
	/** Whether to generate sourcemaps */
	sourcemap?: boolean | "linked" | "inline" | "external";
	/** Whether to minify */
	minify?: boolean;
	/** Additional plugins */
	plugins?: BunPlugin[];
	/** Format - defaults to 'esm' */
	format?: "esm" | "cjs";
	/** Copy assets configuration */
	assets?: Array<{ from: string; to: string }>;
	/** Whether this is a CLI tool */
	isCli?: boolean;
	/** Whether to generate TypeScript declarations (using tsc separately) */
	generateDts?: boolean;
	/**
	 * The name of the package being built (e.g., "@elizaos/core").
	 * When set, this package will NOT be added to externals to avoid self-referential imports.
	 */
	selfPackageName?: string;
}

/**
 * Get performance timer
 */
export function getTimer() {
	const start = performance.now();
	return {
		elapsed: () => {
			const end = performance.now();
			return (end - start).toFixed(2);
		},
		elapsedMs: () => {
			const end = performance.now();
			return Math.round(end - start);
		},
	};
}

/**
 * Creates a standardized Bun build configuration for elizaOS packages
 */
export async function createElizaBuildConfig(
	options: ElizaBuildOptions,
): Promise<BuildConfig> {
	const {
		root: _root = process.cwd(),
		entrypoints = ["src/index.ts"],
		outdir = "dist",
		target = "node",
		external = [],
		sourcemap = false,
		minify = false,
		plugins = [],
		format = "esm",
		assets: _assets = [],
		selfPackageName,
	} = options;

	// Resolve paths relative to root
	const resolvedEntrypoints = entrypoints
		.filter((entry) => entry && entry.trim() !== "") // Filter out empty strings
		.map((entry) => (entry.startsWith("./") ? entry : `./${entry}`));

	// Common external packages for Node.js targets
	const nodeExternals =
		target === "node" || target === "bun"
			? [
					"node:*",
					"fs",
					"path",
					"crypto",
					"stream",
					"buffer",
					"util",
					"events",
					"url",
					"http",
					"https",
					"os",
					"child_process",
					"worker_threads",
					"cluster",
					"zlib",
					"querystring",
					"string_decoder",
					"tls",
					"net",
					"dns",
					"dgram",
					"readline",
					"repl",
					"vm",
					"assert",
					"console",
					"process",
					"timers",
					"perf_hooks",
					"async_hooks",
				]
			: [];

	// elizaOS workspace packages that should typically be external
	// Filter out the package being built to avoid self-referential imports
	const elizaExternals = [
		"@elizaos/core",
		"@elizaos/server",
		"@elizaos/client",
		"@elizaos/api-client",
		"@elizaos/shared",
		"@elizaos/plugin-*",
	].filter((pkg) => pkg !== selfPackageName);

	// Filter out empty strings and clean up the external array
	const cleanExternals = [...external].filter(
		(ext) => ext && !ext.startsWith("//") && ext.trim() !== "",
	);

	const config: BuildConfig = {
		entrypoints: resolvedEntrypoints,
		outdir,
		target: target === "node" ? "node" : target,
		format,
		// 'splitting' option removed - not part of Bun's BuildConfig type
		// splitting: format === 'esm' && entrypoints.length > 1,
		sourcemap,
		minify,
		external: [...nodeExternals, ...elizaExternals, ...cleanExternals],
		plugins,
		naming: {
			entry: "[dir]/[name].[ext]",
			chunk: "[name]-[hash].[ext]",
			asset: "[name]-[hash].[ext]",
		},
	};

	return config;
}

/**
 * Copy assets after build with proper error handling (parallel processing)
 */
export async function copyAssets(assets: Array<{ from: string; to: string }>) {
	if (!assets.length) return;

	const timer = getTimer();
	const { cp } = await import("node:fs/promises");

	console.log("Copying assets...");

	// Process all assets in parallel
	const copyPromises = assets.map(async (asset) => {
		const assetTimer = getTimer();
		try {
			if (existsSync(asset.from)) {
				await cp(asset.from, asset.to, { recursive: true });
				return {
					success: true,
					message: `Copied ${asset.from} to ${asset.to} (${assetTimer.elapsed()}ms)`,
					asset,
				};
			} else {
				return {
					success: false,
					message: `Source not found: ${asset.from}`,
					asset,
					error: "Source not found",
				};
			}
		} catch (error: unknown) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				message: `Failed to copy ${asset.from} to ${asset.to}: ${errorMessage}`,
				asset,
				error: errorMessage,
			};
		}
	});

	// Wait for all copies to complete
	const results = await Promise.all(copyPromises);

	// Process results
	let successCount = 0;
	const failedAssets: Array<{
		asset: { from: string; to: string };
		error: string;
	}> = [];

	results.forEach((result) => {
		if (result.success) {
			successCount++;
		} else {
			console.warn(`  ⚠ ${result.message}`);
			if (result.error) {
				// Check for specific error types
				if (result.error.includes("EACCES") || result.error.includes("EPERM")) {
					console.error(
						`    Permission denied. Try running with elevated privileges.`,
					);
				} else if (result.error.includes("ENOSPC")) {
					console.error(`    Insufficient disk space.`);
				}
				failedAssets.push({ asset: result.asset, error: result.error });
			}
		}
	});

	const totalTime = timer.elapsed();

	if (failedAssets.length === 0) {
		console.log(`✓ Assets copied (${totalTime}ms)`);
	} else if (successCount > 0) {
		console.warn(
			`⚠ Copied ${successCount}/${assets.length} assets (${totalTime}ms)`,
		);
		console.warn(
			`  Failed assets: ${failedAssets.map((f) => f.asset.from).join(", ")}`,
		);
	} else {
		throw new Error(
			`Failed to copy all assets. Errors: ${failedAssets.map((f) => `${f.asset.from}: ${f.error}`).join("; ")}`,
		);
	}
}

/**
 * Generate TypeScript declarations using tsc
 */
export async function generateDts(
	tsconfigPath = "./tsconfig.build.json",
	throwOnError = true,
) {
	const timer = getTimer();
	const { $ } = await import("bun");

	if (!existsSync(tsconfigPath)) {
		console.warn(
			`TypeScript config not found at ${tsconfigPath}, skipping d.ts generation`,
		);
		return;
	}

	console.log("Generating TypeScript declarations...");
	try {
		// Use incremental compilation for faster subsequent builds
		await $`tsc --emitDeclarationOnly --project ${tsconfigPath} --composite false --incremental false --types node,bun`;
		console.log(
			`✓ TypeScript declarations generated successfully (${timer.elapsed()}ms)`,
		);
	} catch (error: unknown) {
		console.error(
			`✗ Failed to generate TypeScript declarations (${timer.elapsed()}ms)`,
		);
		console.error(
			"Error details:",
			error instanceof Error ? error.message : String(error),
		);

		if (throwOnError) {
			// Propagate so calling build fails hard on TS errors
			throw error;
		}
		console.warn("Continuing build without TypeScript declarations...");
	}
}

/**
 * Clean build artifacts with proper error handling and retry logic
 */
export async function cleanBuild(outdir = "dist", maxRetries = 3) {
	const timer = getTimer();
	const { rm } = await import("node:fs/promises");

	if (!existsSync(outdir)) {
		console.log(`✓ ${outdir} directory already clean (${timer.elapsed()}ms)`);
		return;
	}

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			await rm(outdir, { recursive: true, force: true });
			console.log(`✓ Cleaned ${outdir} directory (${timer.elapsed()}ms)`);
			return; // Success, exit the function
		} catch (error: unknown) {
			lastError = error;
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			// Check for specific error types
			if (errorMessage.includes("EACCES") || errorMessage.includes("EPERM")) {
				console.error(`✗ Permission denied while cleaning ${outdir}`);
				console.error(
					`  Try running with elevated privileges or check file permissions.`,
				);
				throw error; // Don't retry permission errors
			} else if (errorMessage.includes("ENOENT")) {
				// Directory was already deleted (possibly by concurrent process)
				console.log(
					`✓ ${outdir} directory was already removed (${timer.elapsed()}ms)`,
				);
				return;
			} else if (
				errorMessage.includes("EBUSY") ||
				errorMessage.includes("EMFILE")
			) {
				// Resource busy or too many open files - these might be temporary
				if (attempt < maxRetries) {
					const waitTime = attempt * 500; // Exponential backoff: 500ms, 1000ms, 1500ms
					console.warn(
						`⚠ Failed to clean ${outdir} (attempt ${attempt}/${maxRetries}): ${errorMessage}`,
					);
					console.warn(`  Retrying in ${waitTime}ms...`);
					await new Promise((resolve) => setTimeout(resolve, waitTime));
				}
			} else {
				// Unknown error
				console.error(`✗ Failed to clean ${outdir}: ${errorMessage}`);
				throw error;
			}
		}
	}

	// If we've exhausted all retries
	const finalError =
		lastError instanceof Error ? lastError : new Error(String(lastError));
	console.error(`✗ Failed to clean ${outdir} after ${maxRetries} attempts`);
	throw finalError;
}

/**
 * Watch files for changes and trigger rebuilds with proper cleanup
 */
export function watchFiles(
	directory: string,
	onChange: () => void,
	options: {
		extensions?: string[];
		debounceMs?: number;
	} = {},
): () => void {
	const { extensions = [".ts", ".js", ".tsx", ".jsx"], debounceMs = 100 } =
		options;

	let debounceTimer: NodeJS.Timeout | null = null;
	let watcher: FSWatcher | null = null;
	let isCleanedUp = false;

	console.log(`📁 Watching ${directory} for changes...`);
	console.log("💡 Press Ctrl+C to stop\n");

	// Cleanup function to close watcher and clear timers
	const cleanup = () => {
		if (isCleanedUp) return;
		isCleanedUp = true;

		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}

		if (watcher) {
			try {
				watcher.close();
			} catch (_error) {
				// Ignore errors during cleanup
			}
			watcher = null;
		}
	};

	// Create the watcher with proper error handling
	watcher = watch(directory, { recursive: true }, (_eventType, filename) => {
		if (isCleanedUp) return;

		if (filename && extensions.some((ext) => filename.endsWith(ext))) {
			// Debounce to avoid multiple rapid rebuilds
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}

			debounceTimer = setTimeout(() => {
				if (!isCleanedUp) {
					console.log(`\n📝 File changed: ${filename}`);
					onChange();
				}
			}, debounceMs);
		}
	});

	// Handle watcher errors
	if (watcher && typeof watcher.on === "function") {
		watcher.on("error", (error: Error) => {
			console.error("Watch error:", error.message);
			if (error.message.includes("EMFILE")) {
				console.error(
					"Too many open files. Consider increasing your system limits or reducing the watch scope.",
				);
			}
		});
	}

	// Register cleanup handlers only once per watcher
	const handleExit = () => {
		cleanup();
		console.log("\n\n👋 Stopping watch mode...");
		process.exit(0);
	};

	// Remove any existing handlers to avoid duplicates
	process.removeAllListeners("SIGINT");
	process.removeAllListeners("SIGTERM");

	// Add new handlers
	process.once("SIGINT", handleExit);
	process.once("SIGTERM", handleExit);

	// Also cleanup on normal exit
	process.once("exit", cleanup);

	// Return cleanup function for manual cleanup
	return cleanup;
}

/**
 * Standard build runner configuration
 */
export interface BuildRunnerOptions {
	packageName: string;
	buildOptions: ElizaBuildOptions;
	onBuildComplete?: (success: boolean) => void;
}

/**
 * Run a build with optional watch mode support
 */
export async function runBuild(
	options: BuildRunnerOptions & { isRebuild?: boolean },
) {
	const {
		packageName,
		buildOptions,
		isRebuild = false,
		onBuildComplete,
	} = options;
	const totalTimer = getTimer();

	// Clear console and show timestamp for rebuilds
	if (isRebuild) {
		console.clear();
		const timestamp = new Date().toLocaleTimeString();
		console.log(`[${timestamp}] 🔄 Rebuilding ${packageName}...\n`);
	} else {
		console.log(`🚀 Building ${packageName}...\n`);
	}

	// Clean previous build
	await cleanBuild(buildOptions.outdir);

	// Bun.build does not always recreate an emptied outdir; ensure it exists after clean.
	const resolvedOutdir = buildOptions.outdir ?? "dist";
	mkdirSync(resolvedOutdir, { recursive: true });

	// Create build configuration
	const configTimer = getTimer();
	const config = await createElizaBuildConfig(buildOptions);
	console.log(`✓ Configuration prepared (${configTimer.elapsed()}ms)`);

	// Build with Bun
	console.log("\nBundling with Bun...");
	const buildTimer = getTimer();
	const result = await Bun.build(config);

	if (!result.success) {
		console.error("✗ Build failed:", result.logs);
		onBuildComplete?.(false);
		return false;
	}

	const totalSize = result.outputs.reduce(
		(sum, output) => sum + output.size,
		0,
	);
	const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
	console.log(
		`✓ Built ${result.outputs.length} file(s) - ${sizeMB}MB (${buildTimer.elapsed()}ms)`,
	);

	// Run post-build tasks
	const postBuildTasks: Promise<undefined | null>[] = [];

	// Add TypeScript declarations generation if requested
	if (buildOptions.generateDts) {
		postBuildTasks.push(
			generateDts("./tsconfig.build.json")
				.then(() => undefined)
				.catch((err) => {
					console.error("⚠ TypeScript declarations generation failed:", err);
					// Don't throw here, as it's often non-critical
					return null;
				}),
		);
	}

	// Add asset copying if specified
	if (buildOptions.assets && buildOptions.assets.length > 0) {
		postBuildTasks.push(
			copyAssets(buildOptions.assets)
				.then(() => undefined)
				.catch((err) => {
					console.error("✗ Asset copying failed:", err);
					throw err; // Asset copying failure is critical
				}),
		);
	}

	// Execute all post-build tasks
	if (postBuildTasks.length > 0) {
		const postBuildTimer = getTimer();
		await Promise.all(postBuildTasks);
		console.log(`✓ Post-build tasks completed (${postBuildTimer.elapsed()}ms)`);
	}

	console.log(`\n✅ ${packageName} build complete!`);
	console.log(`⏱️  Total build time: ${totalTimer.elapsed()}ms`);

	onBuildComplete?.(true);
	return true;
}

/**
 * Create a standardized build runner with watch mode support
 */
export function createBuildRunner(options: BuildRunnerOptions) {
	const isWatchMode = process.argv.includes("--watch");
	let cleanupWatcher: (() => void) | null = null;

	async function build(isRebuild = false) {
		return runBuild({
			...options,
			isRebuild,
		});
	}

	async function startWatchMode() {
		console.log("👀 Starting watch mode...\n");

		// Initial build
		const buildSuccess = await build(false);

		if (buildSuccess) {
			const srcDir = join(process.cwd(), "src");

			// Store the cleanup function returned by watchFiles
			// The watcher stays active throughout the entire session
			cleanupWatcher = watchFiles(srcDir, async () => {
				await build(true);
				console.log("📁 Watching src/ directory for changes...");
				console.log("💡 Press Ctrl+C to stop\n");
			});
		}
	}

	// Ensure cleanup on process exit
	const cleanup = () => {
		if (cleanupWatcher) {
			cleanupWatcher();
			cleanupWatcher = null;
		}
	};

	process.once("beforeExit", cleanup);
	process.once("SIGUSR1", cleanup);
	process.once("SIGUSR2", cleanup);

	// Return the main function to run
	return async function run() {
		if (isWatchMode) {
			await startWatchMode();
		} else {
			const success = await build();
			if (!success) {
				process.exit(1);
			}
		}
	};
}

// Source directory for TypeScript
const TS_SRC = "src";

// Ensure dist directories exist
["dist", "dist/node", "dist/browser", "dist/edge"].forEach((dir) => {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
});

// Browser-specific externals (these should be provided by the host environment)
const browserExternals = [
	// These will be loaded via CDN or bundled by the consuming app
	"sharp", // Image processing - not available in browser
	"@hapi/shot", // Test utility - not needed in browser
	"@opentelemetry/context-async-hooks", // Exclude OpenTelemetry Node modules
	"async_hooks", // Node.js built-in module
	"node:diagnostics_channel", // Node.js built-in module
	"node:async_hooks", // Node.js built-in module
	"fs-extra", // Node-only fs library; host bundlers stub this for browser/Capacitor
];

// Node-specific externals (native modules and node-specific packages)
const nodeExternals = ["dotenv", "sharp", "zod", "@hapi/shot"];

// Shared configuration
const sharedConfig = {
	packageName: "@elizaos/core",
	sourcemap: true,
	minify: false,
	generateDts: true,
};

/**
 * Build for Node.js environment
 */
async function buildNode() {
	console.log("🔨 Building for Node.js...");
	const startTime = Date.now();

	const runNode = createBuildRunner({
		...sharedConfig,
		buildOptions: {
			entrypoints: [`${TS_SRC}/index.node.ts`, `${TS_SRC}/roles.ts`],
			outdir: "dist/node",
			target: "node",
			format: "esm",
			external: nodeExternals,
			sourcemap: true,
			minify: false,
			generateDts: false, // We'll generate declarations separately for all entry points
			selfPackageName: "@elizaos/core", // Exclude self from externals to avoid self-referential imports
		},
	});

	await runNode();

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`✅ Node.js build complete in ${duration}s`);
}

/**
 * Build for browser environment
 */
async function buildBrowser() {
	console.log("🌐 Building for Browser...");
	const startTime = Date.now();

	const runBrowser = createBuildRunner({
		...sharedConfig,
		buildOptions: {
			entrypoints: [`${TS_SRC}/index.browser.ts`, `${TS_SRC}/roles.ts`],
			outdir: "dist/browser",
			// Use the Node target so `node:*` imports bundle without broken browser polyfills.
			// The dashboard/Vite shell still aliases `node:*` where the bundle runs in the browser.
			target: "node",
			format: "esm",
			external: browserExternals,
			sourcemap: true,
			minify: true, // Minify for browser to reduce bundle size
			generateDts: false, // Use the same .d.ts files from Node build
			plugins: [],
			selfPackageName: "@elizaos/core", // Exclude self from externals to avoid self-referential imports
		},
	});

	await runBrowser();

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`✅ Browser build complete in ${duration}s`);
}

/**
 * Build for edge runtimes (Vercel Edge, Cloudflare Workers, Deno Deploy)
 */
async function buildEdge() {
	console.log("⚡ Building for Edge...");
	const startTime = Date.now();

	const runEdge = createBuildRunner({
		...sharedConfig,
		buildOptions: {
			entrypoints: [`${TS_SRC}/index.edge.ts`],
			outdir: "dist/edge",
			target: "node",
			format: "esm",
			external: browserExternals,
			sourcemap: true,
			minify: false,
			generateDts: false,
			selfPackageName: "@elizaos/core",
		},
	});

	await runEdge();

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`✅ Edge build complete in ${duration}s`);
}

/**
 * Build testing module (Node.js only)
 */
async function buildTesting() {
	console.log("🧪 Building testing module...");
	const startTime = Date.now();

	const runTesting = createBuildRunner({
		...sharedConfig,
		buildOptions: {
			entrypoints: [`${TS_SRC}/testing/index.ts`],
			outdir: "dist/testing",
			target: "node",
			format: "esm",
			external: [...nodeExternals, "@elizaos/plugin-sql"],
			sourcemap: true,
			minify: false,
			generateDts: false,
			selfPackageName: "@elizaos/core", // Exclude self from externals to avoid self-referential imports
		},
	});

	await runTesting();

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`✅ Testing module build complete in ${duration}s`);
}

async function buildNodeOnly() {
	console.log("🚀 Starting Node-only build process for @elizaos/core");
	const totalStart = Date.now();

	await Promise.all([buildNode(), buildTesting()]);
	await generateTypeScriptDeclarations();

	const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
	console.log(`\n🎉 Node-only build complete in ${totalDuration}s`);
}

/**
 * Build for both targets
 */
async function buildAll() {
	console.log("🚀 Starting dual build process for @elizaos/core");
	const totalStart = Date.now();

	// Build JS in parallel first
	await Promise.all([buildNode(), buildBrowser(), buildEdge(), buildTesting()]);

	// Generate TypeScript declarations AFTER JS builds complete
	// This prevents race conditions where buildNode() might clean dist/node
	// after generateTypeScriptDeclarations() creates the index.d.ts file
	await generateTypeScriptDeclarations();

	const totalDuration = ((Date.now() - totalStart) / 1000).toFixed(2);
	console.log(`\n🎉 All builds complete in ${totalDuration}s`);
}

/**
 * Rewrite relative module specifiers in emitted `.d.ts` files so they carry
 * explicit `.js` extensions.
 *
 * tsc is run with `moduleResolution: "bundler"` for declarations (so internal
 * source does not need to write extensions), but that leaves barrel re-exports
 * like `export * from "./utils/state-dir"` in the emitted `.d.ts` files.
 * External consumers compiled under `moduleResolution: "nodenext"` (the
 * package's own `tsconfig.base.json` default) cannot resolve those — the
 * symbol set becomes invisible, which is why downstream packages such as
 * `@elizaos/skills` lost access to `resolveStateDir` and had to keep an inline
 * copy.
 *
 * This pass walks `dist/**\/*.d.ts`, finds relative `import`/`export`
 * specifiers, and rewrites them:
 *   - `"./foo"`        → `"./foo.js"`
 *   - `"./foo.ts"`     → `"./foo.js"`
 *   - `"./foo/index"`  → `"./foo/index.js"`
 *   - `"./foo.js"`     → unchanged
 *   - `"./foo.json"`   → unchanged (non-script asset)
 * Bare-directory specifiers (e.g. `"./foo"` where `foo/` is a directory) are
 * rewritten to `"./foo/index.js"` so NodeNext can follow them.
 */
async function fixDtsExtensions(rootDir: string): Promise<void> {
	const path = await import("node:path");
	const fs = await import("node:fs/promises");

	const walk = async (dir: string): Promise<string[]> => {
		const out: string[] = [];
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				out.push(...(await walk(full)));
			} else if (entry.isFile() && full.endsWith(".d.ts")) {
				out.push(full);
			}
		}
		return out;
	};

	// Patterns that capture `from "..."` and `import("...")` and
	// `export * from "..."` style specifiers. We rewrite only the specifier
	// content, preserving the surrounding syntax.
	const specifierRegex =
		/(\bfrom\s*['"]|\bimport\s*\(\s*['"])(\.\.?\/[^'"]+)(['"])/g;

	const rewriteSpecifier = async (
		fileDir: string,
		spec: string,
	): Promise<string> => {
		// Already has a terminal script/asset extension — leave alone.
		if (/\.(js|mjs|cjs|json)$/.test(spec)) {
			return spec;
		}
		// TypeScript source extension leaked into emitted d.ts — rewrite to .js.
		if (/\.tsx?$/.test(spec)) {
			return spec.replace(/\.tsx?$/, ".js");
		}
		// `./foo.d.ts` style — rewrite to `.js`.
		if (/\.d\.ts$/.test(spec)) {
			return spec.replace(/\.d\.ts$/, ".js");
		}
		// No extension. Prefer a sibling `.js`/`.d.ts` if one exists — TypeScript
		// resolves `utils.ts` over `utils/index.ts` when both are present, so
		// after emit we must mirror that choice. We check `.d.ts` too because
		// the runtime bundle may inline JS (so no sibling `.js` is emitted) but
		// declarations are still written per file.
		const resolved = path.resolve(fileDir, spec);
		const siblingExists = await Promise.any([
			fs.stat(`${resolved}.js`).then((s) => s.isFile()),
			fs.stat(`${resolved}.d.ts`).then((s) => s.isFile()),
		]).catch(() => false);
		if (siblingExists) {
			return `${spec}.js`;
		}
		const dirStat = await fs
			.stat(resolved)
			.then((s) => s.isDirectory())
			.catch(() => false);
		return dirStat ? `${spec}/index.js` : `${spec}.js`;
	};

	const files = await walk(rootDir);
	let rewrittenFiles = 0;
	let rewrittenSpecifiers = 0;

	const readDtsWithRetry = async (file: string): Promise<string> => {
		let last: Error | undefined;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				return await fs.readFile(file, "utf8");
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				last = err instanceof Error ? err : new Error(String(e));
				if (err.code === "ENOENT" && attempt < 4) {
					await new Promise((r) => setTimeout(r, 30 * (attempt + 1)));
					continue;
				}
				throw last;
			}
		}
		throw last ?? new Error(`Failed to read ${file}`);
	};

	for (const file of files) {
		const src = await readDtsWithRetry(file);
		const fileDir = path.dirname(file);
		const matches: Array<{ start: number; end: number; replacement: string }> =
			[];

		// Collect matches with indices — we rewrite in a second pass because
		// `rewriteSpecifier` is async.
		for (const m of src.matchAll(specifierRegex)) {
			const [, prefix, spec, suffix] = m;
			const matchStart = m.index ?? 0;
			const newSpec = await rewriteSpecifier(fileDir, spec);
			if (newSpec === spec) continue;
			matches.push({
				start: matchStart,
				end: matchStart + prefix.length + spec.length + suffix.length,
				replacement: `${prefix}${newSpec}${suffix}`,
			});
		}

		if (matches.length === 0) continue;

		// Apply replacements right-to-left to keep earlier indices stable.
		let patched = src;
		for (let i = matches.length - 1; i >= 0; i--) {
			const { start, end, replacement } = matches[i];
			patched = patched.slice(0, start) + replacement + patched.slice(end);
		}

		await fs.writeFile(file, patched, "utf8");
		rewrittenFiles++;
		rewrittenSpecifiers += matches.length;
	}

	console.log(
		`   Rewrote ${rewrittenSpecifiers} relative specifier(s) in ${rewrittenFiles} .d.ts file(s) for NodeNext ESM`,
	);
}

/**
 * Generate TypeScript declarations for all entry points
 */
async function generateTypeScriptDeclarations() {
	const fs = await import("node:fs/promises");
	const { $ } = await import("bun");

	console.log("📝 Generating TypeScript declarations...");
	const startTime = Date.now();

	// Generate TypeScript declarations using tsc
	console.log("   Compiling TypeScript declarations...");
	await $`tsc --project tsconfig.declarations.json`;

	// Post-process: add `.js` extensions to all relative specifiers so external
	// consumers compiled under `moduleResolution: "nodenext"` can resolve them.
	await fixDtsExtensions("dist");

	// Ensure directories exist for conditional exports
	await fs.mkdir("dist/node", { recursive: true });
	await fs.mkdir("dist/browser", { recursive: true });
	await fs.mkdir("dist/edge", { recursive: true });

	// Create re-export files for conditional exports structure
	// dist/node/index.d.ts - points to the Node.js entry point
	// Note: Use .js extension for NodeNext module resolution compatibility
	await fs.writeFile(
		"dist/node/index.d.ts",
		`// Type definitions for @elizaos/core (Node.js)\nexport * from '../index.node.js';\n`,
	);

	// dist/browser/index.d.ts - points to the browser entry point
	await fs.writeFile(
		"dist/browser/index.d.ts",
		`// Type definitions for @elizaos/core (Browser)\nexport * from '../index.browser.js';\n`,
	);

	// dist/edge/index.d.ts - points to the edge entry point
	await fs.writeFile(
		"dist/edge/index.d.ts",
		`// Type definitions for @elizaos/core (Edge)\nexport * from './index.edge.js';\n`,
	);

	// Create main index.js for runtime fallback (when conditional exports don't match)
	await fs.writeFile(
		"dist/index.js",
		`// Main entry point fallback for @elizaos/core\nexport * from './node/index.node.js';\n`,
	);

	// Some tooling (including Bun in certain situations) may attempt to follow the
	// "dist/index.d.ts -> ./index.node" re-export at runtime. Provide explicit JS
	// entrypoints so resolution always lands on real JS modules.
	await fs.writeFile(
		"dist/index.node.js",
		`// Node entry point (explicit)\nexport * from './node/index.node.js';\n`,
	);
	await fs.writeFile(
		"dist/index.browser.js",
		`// Browser entry point (explicit)\nexport * from './browser/index.browser.js';\n`,
	);
	await fs.writeFile(
		"dist/roles.js",
		`// Roles subpath entry point (explicit)\nexport * from './node/roles.js';\n`,
	);

	// Create main index.d.ts to re-export all types from node build
	// This ensures TypeScript resolves all exports when using moduleResolution: bundler
	// Note: Use .js extension for NodeNext module resolution compatibility
	await fs.writeFile(
		"dist/index.d.ts",
		`// Type definitions for @elizaos/core\n// Re-exports all types from the Node.js entry point\nexport * from './index.node.js';\n`,
	);

	// Ensure testing module directory and declarations exist
	await fs.mkdir("dist/testing", { recursive: true });

	const duration = ((Date.now() - startTime) / 1000).toFixed(2);
	console.log(`✅ TypeScript declarations generated in ${duration}s`);
}

if (import.meta.main) {
	const isNodeOnly = process.argv.includes("--node-only");
	const build = isNodeOnly ? buildNodeOnly : buildAll;

	build().catch((error) => {
		console.error("Build script error:", error);
		process.exit(1);
	});
}
