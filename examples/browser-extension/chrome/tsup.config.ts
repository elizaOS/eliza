import { defineConfig } from "tsup";
import path from "path";

// Monorepo paths
const monorepoRoot = path.resolve(__dirname, "../../..");
const packagesDir = path.join(monorepoRoot, "packages");
const pluginsDir = path.join(monorepoRoot, "plugins");

// Helper to resolve @elizaos packages from monorepo
function resolvePackage(pkg: string, browserPath?: string): string {
  const pkgName = pkg.replace("@elizaos/", "");
  
  // Check if it's a core package or a plugin
  let basePath: string;
  if (pkgName === "core") {
    // Core package is at packages/typescript
    basePath = path.join(packagesDir, "typescript");
  } else {
    // Plugins have a typescript/ subdirectory
    basePath = path.join(pluginsDir, pkgName, "typescript");
  }
  
  return browserPath ? path.join(basePath, browserPath) : basePath;
}

// Node.js packages that should not be bundled for browser
const nodeExternals = [
  "@vercel/oidc",
  "sharp",
  "fs",
  "path",
  "crypto",
  "http",
  "https",
  "net",
  "tls",
  "stream",
  "zlib",
  "os",
  "child_process",
  "worker_threads",
  "async_hooks",
  "node:*",
];

export default defineConfig([
  // Background script
  {
    entry: { background: "src/background.ts" },
    outDir: "dist",
    format: ["iife"],
    target: "chrome120",
    platform: "browser",
    splitting: false,
    sourcemap: true,
    clean: false,
    noExternal: [/.*/], // Bundle everything
    globalName: "elizaOSBackground",
    esbuildOptions(options) {
      options.define = {
        "process.env.NODE_ENV": '"production"',
      };
      options.alias = {
        "@elizaos/core": resolvePackage("@elizaos/core"),
        "@elizaos/plugin-openai": resolvePackage("@elizaos/plugin-openai"),
        "@elizaos/plugin-anthropic": resolvePackage("@elizaos/plugin-anthropic"),
        "@elizaos/plugin-groq": resolvePackage("@elizaos/plugin-groq"),
        "@elizaos/plugin-google-genai": resolvePackage("@elizaos/plugin-google-genai"),
        "@elizaos/plugin-eliza-classic": resolvePackage("@elizaos/plugin-eliza-classic"),
        "@elizaos/plugin-inmemorydb": resolvePackage("@elizaos/plugin-inmemorydb"),
      };
    },
  },
  // Offscreen document script (keeps runtime alive when popup closes)
  {
    entry: { offscreen: "src/offscreen.ts" },
    outDir: "dist",
    format: ["esm"],
    target: "chrome120",
    platform: "browser",
    splitting: false,
    sourcemap: true,
    clean: false,
    noExternal: [/.*/],
    banner: {
      js: `// Browser shims
if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: { NODE_ENV: 'production' }, cwd: () => '/', versions: {}, browser: true };
}
console.log("[elizaOS] Offscreen bundle starting...");`,
    },
    esbuildOptions(options) {
      options.define = {
        "process.env.NODE_ENV": '"production"',
        "process.env.DOTENV_KEY": '""',
        "process.env.DOTENV_CONFIG_DEBUG": '""',
        "process.env.DOTENV_CONFIG_QUIET": '""',
        "process.env.NODE_DEBUG": '""',
        global: "globalThis",
      };
      options.alias = {
        "@elizaos/core": resolvePackage("@elizaos/core", "dist/browser/index.browser.js"),
        "@elizaos/plugin-openai": resolvePackage("@elizaos/plugin-openai", "dist/browser/index.browser.js"),
        "@elizaos/plugin-anthropic": resolvePackage("@elizaos/plugin-anthropic", "dist/browser/index.browser.js"),
        "@elizaos/plugin-groq": resolvePackage("@elizaos/plugin-groq", "dist/browser/index.browser.js"),
        "@elizaos/plugin-google-genai": resolvePackage("@elizaos/plugin-google-genai", "dist/browser/index.browser.js"),
        "@elizaos/plugin-eliza-classic": resolvePackage("@elizaos/plugin-eliza-classic", "dist/browser/index.browser.js"),
        "@elizaos/plugin-inmemorydb": resolvePackage("@elizaos/plugin-inmemorydb", "dist/browser/index.js"),
        "@vercel/oidc": path.join(__dirname, "src/stubs/empty.js"),
        dotenv: path.join(__dirname, "src/stubs/empty.js"),
        "fast-redact": path.join(__dirname, "src/stubs/fast-redact.js"),
      };
    },
  },
  // Content script - IIFE outputs as content.global.js
  {
    entry: { content: "src/content.ts" },
    outDir: "dist",
    format: ["iife"],
    target: "chrome120",
    platform: "browser",
    splitting: false,
    sourcemap: true,
    clean: false,
    noExternal: [/.*/],
    globalName: "elizaOSContent",
  },
  // Popup script - full elizaOS version
  {
    entry: { popup: "src/popup-full.ts" },
    outDir: "dist",
    format: ["esm"],
    target: "chrome120",
    platform: "browser",
    splitting: false,
    sourcemap: true,
    clean: false,
    noExternal: [/.*/],
    banner: {
      js: `// Browser shims
if (typeof globalThis.process === 'undefined') {
  globalThis.process = { env: { NODE_ENV: 'production' }, cwd: () => '/', versions: {}, browser: true };
}
console.log("[elizaOS] Bundle starting...");`,
    },
    esbuildOptions(options) {
      options.define = {
        "process.env.NODE_ENV": '"production"',
        "process.env.DOTENV_KEY": '""',
        "process.env.DOTENV_CONFIG_DEBUG": '""',
        "process.env.DOTENV_CONFIG_QUIET": '""',
        "process.env.NODE_DEBUG": '""',
        global: "globalThis",
      };
      // Bundle from source to avoid broken default exports in pre-built plugin dists
      options.alias = {
        "@elizaos/core": resolvePackage("@elizaos/core", "dist/browser/index.browser.js"),
        "@elizaos/plugin-openai": resolvePackage("@elizaos/plugin-openai", "dist/browser/index.browser.js"),
        "@elizaos/plugin-anthropic": resolvePackage("@elizaos/plugin-anthropic", "dist/browser/index.browser.js"),
        "@elizaos/plugin-groq": resolvePackage("@elizaos/plugin-groq", "dist/browser/index.browser.js"),
        "@elizaos/plugin-google-genai": resolvePackage("@elizaos/plugin-google-genai", "dist/browser/index.browser.js"),
        "@elizaos/plugin-eliza-classic": resolvePackage("@elizaos/plugin-eliza-classic", "dist/browser/index.browser.js"),
        "@elizaos/plugin-inmemorydb": resolvePackage("@elizaos/plugin-inmemorydb", "dist/browser/index.js"),
        // Stub Node.js packages
        "@vercel/oidc": path.join(__dirname, "src/stubs/empty.js"),
        "dotenv": path.join(__dirname, "src/stubs/empty.js"),
        "fast-redact": path.join(__dirname, "src/stubs/fast-redact.js"),
      };
    },
  },
]);
