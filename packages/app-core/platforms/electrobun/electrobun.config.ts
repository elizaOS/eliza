import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectrobunConfig } from "electrobun/bun";

const electrobunDir = path.dirname(fileURLToPath(import.meta.url));

export function hasElectrobunWorkspaceRoot(candidateDir: string): boolean {
	return (
		fs.existsSync(path.join(candidateDir, "bun.lock")) &&
		fs.existsSync(path.join(candidateDir, "package.json")) &&
		(fs.existsSync(path.join(candidateDir, "packages/app/package.json")) ||
			fs.existsSync(path.join(candidateDir, "apps/app/package.json"))) &&
		(fs.existsSync(
			path.join(
				candidateDir,
				"packages/app-core/platforms/electrobun/package.json",
			),
		) ||
			fs.existsSync(
				path.join(
					candidateDir,
					"eliza/packages/app-core/platforms/electrobun/package.json",
				),
			))
	);
}

function hasOuterElizaElectrobunCheckout(candidateDir: string): boolean {
	return fs.existsSync(
		path.join(
			candidateDir,
			"eliza",
			"packages",
			"app-core",
			"platforms",
			"electrobun",
			"package.json",
		),
	);
}

export function findElizaRepoRoot(startDir: string): string {
	let current = path.resolve(startDir);
	const matches: string[] = [];
	while (true) {
		if (hasElectrobunWorkspaceRoot(current)) {
			matches.push(current);
		}
		const parent = path.dirname(current);
		if (parent === current) {
			const outerWrapperRoot = matches.find(hasOuterElizaElectrobunCheckout);
			if (outerWrapperRoot) {
				return outerWrapperRoot;
			}
			if (matches[0]) {
				return matches[0];
			}
			throw new Error(
				`Could not locate monorepo root from Electrobun config at ${startDir}`,
			);
		}
		current = parent;
	}
}

export function resolveElectrobunRepoRoot(startDir: string): string {
	const override = (process.env.ELIZA_ELECTROBUN_REPO_ROOT ?? "").trim();
	if (override) {
		const resolved = path.resolve(override);
		if (!hasElectrobunWorkspaceRoot(resolved)) {
			throw new Error(
				`ELIZA_ELECTROBUN_REPO_ROOT does not point at an Electrobun workspace root: ${resolved}`,
			);
		}
		return resolved;
	}

	return findElizaRepoRoot(startDir);
}

const repoRoot = resolveElectrobunRepoRoot(electrobunDir);
const rendererDistDir = path.relative(
	electrobunDir,
	fs.existsSync(path.join(repoRoot, "packages/app/package.json"))
		? path.join(repoRoot, "packages/app/dist")
		: path.join(repoRoot, "apps/app/dist"),
);
const runtimeBundleDistDir = path.relative(
	electrobunDir,
	path.join(repoRoot, "dist"),
);
const repoPluginsJsonPath = path.relative(
	electrobunDir,
	path.join(repoRoot, "plugins.json"),
);
const repoPackageJsonPath = path.relative(
	electrobunDir,
	path.join(repoRoot, "package.json"),
);
const defaultBrandConfigPath = path.join(
	electrobunDir,
	"assets",
	"brand-config.json",
);
const generatedBrandConfigPath = path.join(
	electrobunDir,
	".generated",
	"brand-config.json",
);
const libMacWindowEffectsDylib = path.join(
	electrobunDir,
	"src",
	"libMacWindowEffects.dylib",
);

function readJsonFile(filePath: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: {};
	} catch {
		return {};
	}
}

function trimEnv(name: string): string {
	return (process.env[name] ?? "").trim();
}

function resolveBrandConfigCopySource({
	appName,
	appId,
	urlScheme,
}: {
	appName: string;
	appId: string;
	urlScheme: string;
}): string {
	const explicitConfigPath = trimEnv("ELIZA_BRAND_CONFIG_PATH");
	const namespace = trimEnv("ELIZA_NAMESPACE");
	const appDescription = trimEnv("ELIZA_APP_DESCRIPTION");
	const hasBrandOverride = Boolean(
		explicitConfigPath ||
			trimEnv("ELIZA_APP_NAME") ||
			trimEnv("ELIZA_APP_ID") ||
			trimEnv("ELIZA_URL_SCHEME") ||
			namespace ||
			appDescription,
	);

	if (!hasBrandOverride) {
		return "assets/brand-config.json";
	}

	const fileConfig = explicitConfigPath
		? readJsonFile(path.resolve(explicitConfigPath))
		: readJsonFile(defaultBrandConfigPath);
	const configDirName =
		trimEnv("ELIZA_CONFIG_DIR_NAME") ||
		(explicitConfigPath &&
		typeof fileConfig.configDirName === "string" &&
		fileConfig.configDirName.trim()
			? fileConfig.configDirName
			: appName);
	const brandConfig = {
		...fileConfig,
		appName,
		appId,
		urlScheme,
		namespace: namespace || fileConfig.namespace || "elizaos",
		configDirName,
		...(appDescription
			? { appDescription }
			: typeof fileConfig.appDescription === "string"
				? { appDescription: fileConfig.appDescription }
				: {}),
	};

	fs.mkdirSync(path.dirname(generatedBrandConfigPath), { recursive: true });
	fs.writeFileSync(
		generatedBrandConfigPath,
		`${JSON.stringify(brandConfig, null, "\t")}\n`,
	);

	return path.relative(electrobunDir, generatedBrandConfigPath);
}

export function createElectrobunConfig(): ElectrobunConfig {
	const appName = (process.env.ELIZA_APP_NAME ?? "").trim() || "elizaOS";
	const appId = (process.env.ELIZA_APP_ID ?? "").trim() || "ai.elizaos.app";
	const urlScheme = (process.env.ELIZA_URL_SCHEME ?? "").trim() || "elizaos";
	const releaseUrl = (process.env.ELIZA_RELEASE_URL ?? "").trim() || "";
	const runtimeDistDir =
		(process.env.ELIZA_RUNTIME_DIST_DIR ?? "").trim() || "eliza-dist";
	const brandConfigCopySource = resolveBrandConfigCopySource({
		appName,
		appId,
		urlScheme,
	});
	// Note: All paths relative to electrobun.config.ts location
	// (eliza/packages/app-core/platforms/electrobun/)
	// ../../../../../ goes to eliza repo root where dist/, plugins.json, package.json exist

	return {
		app: {
			name: appName,
			identifier: appId,
			version: "2.0.0-beta.0",
			description: "AI agents for the desktop",
			urlSchemes: [urlScheme],
		},
		runtime: {
			exitOnLastWindowClosed: false,
		},
		scripts: {
			// Sign native code inside the runtime dist node_modules on the inner app bundle
			// before Electrobun runs the platform signing/notarization flow.
			postBuild: "scripts/postwrap-sign-runtime-macos.ts",
			// Capture wrapper-bundle binary metadata after the self-extractor is created.
			postWrap: "scripts/postwrap-diagnostics.ts",
		},
		build: {
			bun: {
				entrypoint: "src/index.ts",
				// The Electrobun bun process is a thin native shell — it creates
				// windows, dispatches RPCs to the renderer, and manages the embedded
				// API subprocess (or talks to an external API). It must NOT bundle
				// the agent runtime, plugins, database, or ML stacks — those belong
				// in the API subprocess. Any of these reaching the Electrobun bun
				// bundle is a sign of an unintended import edge; either cut the edge
				// or extend this list.
				external: [
					// Agent runtime packages — used only via type imports in the bun
					// src, but workspace TS resolution can drag the source graph in.
					"@elizaos/core",
					"@elizaos/agent",
					"@elizaos/app-core",
					// Plugins — initialized by the API subprocess, never the bun shell.
					"@elizaos/plugin-sql",
					"@elizaos/plugin-bootstrap",
					"@elizaos/plugin-local-ai",
					"@elizaos/plugin-local-embedding",
					// Database stack pulled in by plugin-sql.
					"@electric-sql/pglite",
					"drizzle-orm",
					"pg",
					// Native ML/embedding packages ship platform-specific bindings via
					// relative require()s or per-platform sibling packages; bundling
					// them breaks those paths.
					"node-llama-cpp",
					"@node-llama-cpp/*",
					"onnxruntime-node",
					"onnxruntime-common",
					"onnxruntime-web",
					"@huggingface/transformers",
				],
			},
			views: {},
			// Watch these extra dirs in dev --watch mode so changes to the Vite
			// renderer build or shared types trigger a bun-side rebuild + relaunch.
			watch: ["../dist", "src/shared/", "src/bridge/"],
			// Ignore test files and build artifacts from watch triggers.
			watchIgnore: [
				"src/**/*.test.ts",
				"src/**/*.spec.ts",
				"artifacts/",
				"build/",
			],
			// Desktop intentionally supports both WebGPU paths:
			// 1. renderer-webview WebGPU (`three/webgpu` via browser `navigator.gpu`)
			// 2. Electrobun-native Dawn for Bun-side GpuWindow / <electrobun-wgpu>
			//    surfaces and future native compute workloads.
			copy: {
				[rendererDistDir]: "renderer",
				"src/preload.js": "bun/preload.js",
				[runtimeBundleDistDir]: runtimeDistDir,
				[path.join(runtimeBundleDistDir, "node_modules")]:
					`${runtimeDistDir}/node_modules`,
				...(fs.existsSync(path.join(repoRoot, "plugins.json"))
					? { [repoPluginsJsonPath]: `${runtimeDistDir}/plugins.json` }
					: {}),
				[repoPackageJsonPath]: `${runtimeDistDir}/package.json`,
				"assets/appIcon.png": "assets/appIcon.png",
				"assets/appIcon.ico": "assets/appIcon.ico",
				[brandConfigCopySource]: "brand-config.json",
				...(process.platform === "darwin" &&
				fs.existsSync(libMacWindowEffectsDylib)
					? { "src/libMacWindowEffects.dylib": "libMacWindowEffects.dylib" }
					: {}),
			},
			mac: {
				bundleWGPU: true,
				codesign: process.env.ELECTROBUN_SKIP_CODESIGN !== "1",
				notarize:
					process.env.ELECTROBUN_SKIP_CODESIGN !== "1" &&
					process.env.ELIZA_ELECTROBUN_NOTARIZE !== "0",
				defaultRenderer: "native",
				icons: "assets/appIcon.iconset",
				entitlements: {
					"com.apple.security.cs.allow-jit": true,
					"com.apple.security.cs.allow-unsigned-executable-memory": true,
					"com.apple.security.cs.disable-library-validation": true,
					"com.apple.security.network.client": true,
					"com.apple.security.network.server": true,
					"com.apple.security.files.user-selected.read-write": true,
					"com.apple.security.device.camera": true,
					"com.apple.security.device.microphone": true,
					"com.apple.security.device.screen-recording": true,
				},
			},
			linux: {
				bundleCEF: true,
				bundleWGPU: true,
				defaultRenderer: "cef",
				icon: "assets/appIcon.png",
				chromiumFlags: {
					"enable-unsafe-webgpu": true,
					"enable-features": "Vulkan",
					"disable-gpu": false,
					"disable-gpu-compositing": false,
					"disable-gpu-sandbox": false,
					"enable-software-rasterizer": false,
					"force-software-rasterizer": false,
					"disable-accelerated-2d-canvas": false,
					"disable-accelerated-video-decode": false,
					"disable-accelerated-video-encode": false,
					"disable-gpu-memory-buffer-video-frames": false,
				} as unknown as Record<string, string | true>,
			},
			win: {
				bundleCEF: true,
				bundleWGPU: true,
				defaultRenderer: "cef",
				icon: "assets/appIcon.ico",
				chromiumFlags: {
					"enable-unsafe-webgpu": true,
					"enable-features": "Vulkan",
					"in-process-gpu": true,
					"disable-gpu-sandbox": true,
					"no-sandbox": true,
				} as unknown as Record<string, string | true>,
			},
		},
		...(releaseUrl
			? {
					release: {
						baseUrl: releaseUrl,
						generatePatch: true,
					},
				}
			: {}),
	} satisfies ElectrobunConfig;
}

export default createElectrobunConfig();
