import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectrobunConfig } from "electrobun/bun";

const electrobunDir = path.dirname(fileURLToPath(import.meta.url));

function hasElectrobunWorkspaceRoot(candidateDir: string): boolean {
  return (
    fs.existsSync(path.join(candidateDir, "bun.lock")) &&
    fs.existsSync(path.join(candidateDir, "package.json")) &&
    fs.existsSync(path.join(candidateDir, "apps/app/package.json")) &&
    (fs.existsSync(
      path.join(candidateDir, "apps/app/electrobun/package.json"),
    ) ||
      fs.existsSync(
        path.join(
          candidateDir,
          "eliza/packages/app-core/platforms/electrobun/package.json",
        ),
      ))
  );
}

function findMiladyRepoRoot(startDir: string): string {
  let current = path.resolve(startDir);
  while (true) {
    if (hasElectrobunWorkspaceRoot(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not locate monorepo root from Electrobun config at ${startDir}`,
      );
    }
    current = parent;
  }
}

const repoRoot = findMiladyRepoRoot(electrobunDir);
const rendererDistDir = path.relative(
  electrobunDir,
  path.join(repoRoot, "apps/app/dist"),
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
const libMacWindowEffectsDylib = path.join(
  electrobunDir,
  "src",
  "libMacWindowEffects.dylib",
);

export function createElectrobunConfig(): ElectrobunConfig {
  const appName =
    (process.env.ELIZA_APP_NAME ?? process.env.ELIZA_APP_NAME ?? "").trim() ||
    "elizaOS";
  const appId =
    (process.env.ELIZA_APP_ID ?? process.env.ELIZA_APP_ID ?? "").trim() ||
    "ai.elizaos.app";
  const urlScheme =
    (
      process.env.ELIZA_URL_SCHEME ??
      process.env.ELIZA_URL_SCHEME ??
      ""
    ).trim() || "elizaos";
  const releaseUrl =
    (
      process.env.ELIZA_RELEASE_URL ??
      process.env.ELIZA_RELEASE_URL ??
      ""
    ).trim() || "";
  const runtimeDistDir =
    (process.env.ELIZA_RUNTIME_DIST_DIR ?? "").trim() || "eliza-dist";
  // Note: All paths relative to electrobun.config.ts location
  // (eliza/packages/app-core/platforms/electrobun/)
  // ../../../../../ goes to milady repo root where dist/, plugins.json, package.json exist

  return {
    app: {
      name: appName,
      identifier: appId,
      version: "2.0.0-alpha.87",
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
        [repoPluginsJsonPath]: `${runtimeDistDir}/plugins.json`,
        [repoPackageJsonPath]: `${runtimeDistDir}/package.json`,
        "assets/appIcon.png": "assets/appIcon.png",
        "assets/appIcon.ico": "assets/appIcon.ico",
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
          (process.env.ELIZA_ELECTROBUN_NOTARIZE ??
            process.env.ELIZA_ELECTROBUN_NOTARIZE) !== "0",
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
