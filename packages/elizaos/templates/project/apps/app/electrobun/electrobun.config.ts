import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ElectrobunConfig } from "electrobun";

type ChromiumFlags = Record<string, string | boolean>;
type RuntimeConfigKey = "linux" | "win";
type ElectrobunConfigWithRuntimeChromiumFlags = Omit<
  ElectrobunConfig,
  "build"
> & {
  build: Omit<ElectrobunConfig["build"], RuntimeConfigKey> & {
    [K in RuntimeConfigKey]: Omit<
      NonNullable<ElectrobunConfig["build"][K]>,
      "chromiumFlags"
    > & {
      chromiumFlags: ChromiumFlags;
    };
  };
};

const electrobunDir = path.dirname(fileURLToPath(import.meta.url));
const libMacWindowEffectsDylib = path.join(
  electrobunDir,
  "src",
  "libMacWindowEffects.dylib",
);

export default {
  app: {
    name: "__APP_NAME__",
    identifier: "__BUNDLE_ID__",
    version: "2.0.0-beta.0",
    description: "Cute AI agents for the desktop",
    urlSchemes: ["eliza"],
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
  scripts: {
    // Sign native code inside eliza-dist/node_modules on the inner app bundle
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
    // Eliza intentionally supports both desktop WebGPU paths:
    // 1. renderer-webview WebGPU (`three/webgpu` via browser `navigator.gpu`)
    // 2. Electrobun-native Dawn for Bun-side GpuWindow / <electrobun-wgpu>
    //    surfaces and future native compute workloads.
    // Copy the Vite-built renderer (apps/app/dist/) into the bundle as renderer/.
    // The Bun main script lives in app/bun/, so ../renderer resolves to app/renderer/.
    // Also copy the webview bridge preload and native dylib into their expected locations.
    copy: {
      "../dist": "renderer",
      "src/preload.js": "bun/preload.js",
      // elizaOS backend server bundle (tsdown output from repo root dist/).
      // agent.ts walks up from import.meta.dir looking for eliza-dist/ to spawn
      // the canonical runtime entry (`entry.js start`).
      // Paths are relative to apps/app/electrobun/ (where electrobun build is run).
      "../../../dist": "eliza-dist",
      // plugins.json lives at repo root, not in dist/. Without it,
      // findOwnPackageRoot() can't locate the manifest and
      // discoverPluginsFromManifest() returns an empty array.
      "../../../plugins.json": "eliza-dist/plugins.json",
      // package.json is needed so findOwnPackageRoot() can match on the
      // "eliza" package name. dist/package.json only has {"type":"module"}.
      "../../../package.json": "eliza-dist/package.json",
      // Runtime window + tray icons are loaded via path.join(import.meta.dir, "../assets/appIcon.*").
      // import.meta.dir resolves to app/bun/ in the packaged bundle, so these
      // destinations place the assets at app/assets/appIcon.*.
      "assets/appIcon.png": "assets/appIcon.png",
      "assets/appIcon.ico": "assets/appIcon.ico",
      // Optional native blur (run build:native-effects locally). Omit when missing to avoid noisy copy errors in dev.
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
        // JIT compiler support (required for Bun's JIT on hardened+notarized builds)
        "com.apple.security.cs.allow-jit": true,
        // Dynamic executable memory (required alongside allow-jit)
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
        // Library validation disabled (required for third-party native binaries: whisper.cpp, sharp)
        // This also covers unsigned dylib loading — allow-dyld-environment-variables is not needed.
        "com.apple.security.cs.disable-library-validation": true,
        // Network access (API calls, local agent/gateway server)
        "com.apple.security.network.client": true,
        "com.apple.security.network.server": true,
        // File access for screenshots, user-selected files
        "com.apple.security.files.user-selected.read-write": true,
        // Hardware device access
        "com.apple.security.device.camera": true,
        "com.apple.security.device.microphone": true,
        // Screen recording (screencapture)
        "com.apple.security.device.screen-recording": true,
      },
    },
    linux: {
      bundleCEF: true,
      bundleWGPU: true,
      defaultRenderer: "cef",
      icon: "assets/appIcon.png",
      // Enable WebGPU in CEF. The Electrobun Linux defaults disable GPU for VM
      // compatibility; override those with `false` so the GPU pipeline stays active
      // and WebGPU can be used via navigator.gpu.
      chromiumFlags: {
        "enable-unsafe-webgpu": true,
        "enable-features": "Vulkan",
        // Override Linux defaults that disable GPU
        "disable-gpu": false,
        "disable-gpu-compositing": false,
        "disable-gpu-sandbox": false,
        "enable-software-rasterizer": false,
        "force-software-rasterizer": false,
        "disable-accelerated-2d-canvas": false,
        "disable-accelerated-video-decode": false,
        "disable-accelerated-video-encode": false,
        "disable-gpu-memory-buffer-video-frames": false,
      },
    },
    win: {
      bundleCEF: true,
      bundleWGPU: true,
      defaultRenderer: "cef",
      icon: "assets/appIcon.ico",
      // Enable WebGPU in CEF on Windows.
      // The GPU process sandbox causes STATUS_BREAKPOINT crashes
      // (exit code -2147483645) on Windows during GPU initialization,
      // cascading into a fully broken UI.  Running the GPU in-process
      // with the sandbox disabled avoids the crash while keeping
      // hardware-accelerated rendering active.
      chromiumFlags: {
        "enable-unsafe-webgpu": true,
        "enable-features": "Vulkan",
        "in-process-gpu": true,
        "disable-gpu-sandbox": true,
        "no-sandbox": true,
      },
    },
  },
  release: {
    baseUrl: "__RELEASE_BASE_URL__",
    generatePatch: true,
  },
} satisfies ElectrobunConfigWithRuntimeChromiumFlags;
