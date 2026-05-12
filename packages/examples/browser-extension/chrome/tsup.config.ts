import path from "node:path";
import { defineConfig } from "tsup";

// Monorepo paths
const monorepoRoot = path.resolve(__dirname, "../../../..");
const packagesDir = path.join(monorepoRoot, "packages");
const pluginsDir = path.join(monorepoRoot, "plugins");
const emptyStub = path.join(__dirname, "src/stubs/empty.js");
const fastRedactStub = path.join(__dirname, "src/stubs/fast-redact.js");

// Helper to resolve @elizaos packages from monorepo
function resolvePackage(pkg: string, browserPath?: string): string {
  const pkgName = pkg.replace("@elizaos/", "");

  // Check if it's a core package or a plugin
  let basePath: string;
  if (pkgName === "core") {
    // Core package is at packages/core
    basePath = path.join(packagesDir, "core");
  } else {
    basePath = path.join(pluginsDir, pkgName);
  }

  return browserPath ? path.join(basePath, browserPath) : basePath;
}

// Node.js packages that should not be bundled for browser
const _nodeExternals = [
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

const browserOnlyAliases = {
  "@vercel/oidc": emptyStub,
  dotenv: emptyStub,
  "fast-redact": fastRedactStub,
  "fs-extra": emptyStub,
  fs: emptyStub,
  "node:fs": emptyStub,
  "node:fs/promises": emptyStub,
  path: emptyStub,
  "node:path": emptyStub,
  stream: emptyStub,
  "node:stream": emptyStub,
  constants: emptyStub,
  "node:constants": emptyStub,
} as const;

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
    globalName: "ElizaOSBackground",
    esbuildOptions(options) {
      options.define = {
        "process.env.NODE_ENV": '"production"',
      };
      options.alias = {
        "@elizaos/core": resolvePackage("@elizaos/core"),
        "@elizaos/plugin-openai": resolvePackage("@elizaos/plugin-openai"),
        "@elizaos/plugin-anthropic": resolvePackage(
          "@elizaos/plugin-anthropic",
        ),
        "@elizaos/plugin-groq": resolvePackage("@elizaos/plugin-groq"),
        "@elizaos/plugin-google-genai": resolvePackage(
          "@elizaos/plugin-google-genai",
        ),
        "@elizaos/plugin-eliza-classic": resolvePackage(
          "@elizaos/plugin-eliza-classic",
        ),
        "@elizaos/plugin-localdb": resolvePackage("@elizaos/plugin-localdb"),
        "@elizaos/plugin-inmemorydb": resolvePackage(
          "@elizaos/plugin-inmemorydb",
          "index.browser.ts",
        ),
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
console.log("[ElizaOS] Offscreen bundle starting...");`,
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
        "@elizaos/core": resolvePackage(
          "@elizaos/core",
          "dist/browser/index.browser.js",
        ),
        "@elizaos/plugin-openai": resolvePackage(
          "@elizaos/plugin-openai",
          "dist/browser/index.browser.js",
        ),
        "@elizaos/plugin-anthropic": resolvePackage(
          "@elizaos/plugin-anthropic",
          "dist/browser/index.browser.js",
        ),
        "@elizaos/plugin-groq": resolvePackage(
          "@elizaos/plugin-groq",
          "dist/browser/index.browser.js",
        ),
        "@elizaos/plugin-google-genai": resolvePackage(
          "@elizaos/plugin-google-genai",
          "dist/browser/index.browser.js",
        ),
        "@elizaos/plugin-eliza-classic": resolvePackage(
          "@elizaos/plugin-eliza-classic",
          "index.browser.ts",
        ),
        "@elizaos/plugin-localdb": resolvePackage(
          "@elizaos/plugin-localdb",
          "index.browser.ts",
        ),
        "@elizaos/plugin-inmemorydb": resolvePackage(
          "@elizaos/plugin-inmemorydb",
          "index.browser.ts",
        ),
        ...browserOnlyAliases,
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
    globalName: "ElizaOSContent",
  },
  // Popup script - full ElizaOS version
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
console.log("[ElizaOS] Bundle starting...");`,
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
      // Use browser builds of @elizaos packages
      options.alias = {
        "@elizaos/core": resolvePackage(
          "@elizaos/core",
          "dist/browser/index.browser.js",
        ),
        "@elizaos/plugin-openai": resolvePackage(
          "@elizaos/plugin-openai",
          "dist/browser/index.browser.js",
        ),
        "@elizaos/plugin-anthropic": resolvePackage(
          "@elizaos/plugin-anthropic",
          "dist/browser/index.browser.js",
        ),
        "@elizaos/plugin-groq": resolvePackage(
          "@elizaos/plugin-groq",
          "dist/browser/index.browser.js",
        ),
        "@elizaos/plugin-google-genai": resolvePackage(
          "@elizaos/plugin-google-genai",
          "dist/browser/index.browser.js",
        ),
        "@elizaos/plugin-eliza-classic": resolvePackage(
          "@elizaos/plugin-eliza-classic",
          "index.browser.ts",
        ),
        "@elizaos/plugin-localdb": resolvePackage(
          "@elizaos/plugin-localdb",
          "index.browser.ts",
        ),
        "@elizaos/plugin-inmemorydb": resolvePackage(
          "@elizaos/plugin-inmemorydb",
          "index.browser.ts",
        ),
        // Stub Node.js packages
        ...browserOnlyAliases,
      };
    },
  },
]);
