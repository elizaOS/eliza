import { defineConfig } from "tsup";
import path from "path";

// Resolve to the monorepo root node_modules
const rootNodeModules = path.resolve(__dirname, "../../../node_modules");

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
    globalName: "ElizaOSBackground",
    esbuildOptions(options) {
      options.define = {
        "process.env.NODE_ENV": '"production"',
      };
      options.alias = {
        "@elizaos/core": path.join(rootNodeModules, "@elizaos/core"),
        "@elizaos/plugin-openai": path.join(rootNodeModules, "@elizaos/plugin-openai"),
        "@elizaos/plugin-anthropic": path.join(rootNodeModules, "@elizaos/plugin-anthropic"),
        "@elizaos/plugin-groq": path.join(rootNodeModules, "@elizaos/plugin-groq"),
        "@elizaos/plugin-google-genai": path.join(rootNodeModules, "@elizaos/plugin-google-genai"),
        "@elizaos/plugin-eliza-classic": path.join(rootNodeModules, "@elizaos/plugin-eliza-classic"),
        "@elizaos/plugin-localdb": path.join(rootNodeModules, "@elizaos/plugin-localdb"),
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
        "@elizaos/core": path.join(rootNodeModules, "@elizaos/core/dist/browser/index.browser.js"),
        "@elizaos/plugin-openai": path.join(rootNodeModules, "@elizaos/plugin-openai/dist/browser/index.browser.js"),
        "@elizaos/plugin-anthropic": path.join(rootNodeModules, "@elizaos/plugin-anthropic/dist/browser/index.browser.js"),
        "@elizaos/plugin-groq": path.join(rootNodeModules, "@elizaos/plugin-groq/dist/browser/index.browser.js"),
        "@elizaos/plugin-google-genai": path.join(rootNodeModules, "@elizaos/plugin-google-genai/dist/browser/index.browser.js"),
        "@elizaos/plugin-eliza-classic": path.join(rootNodeModules, "@elizaos/plugin-eliza-classic/dist/browser/index.browser.js"),
        "@elizaos/plugin-localdb": path.join(rootNodeModules, "@elizaos/plugin-localdb/dist/browser/index.browser.js"),
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
        "@elizaos/core": path.join(rootNodeModules, "@elizaos/core/dist/browser/index.browser.js"),
        "@elizaos/plugin-openai": path.join(rootNodeModules, "@elizaos/plugin-openai/dist/browser/index.browser.js"),
        "@elizaos/plugin-anthropic": path.join(rootNodeModules, "@elizaos/plugin-anthropic/dist/browser/index.browser.js"),
        "@elizaos/plugin-groq": path.join(rootNodeModules, "@elizaos/plugin-groq/dist/browser/index.browser.js"),
        "@elizaos/plugin-google-genai": path.join(rootNodeModules, "@elizaos/plugin-google-genai/dist/browser/index.browser.js"),
        "@elizaos/plugin-eliza-classic": path.join(rootNodeModules, "@elizaos/plugin-eliza-classic/dist/browser/index.browser.js"),
        "@elizaos/plugin-localdb": path.join(rootNodeModules, "@elizaos/plugin-localdb/dist/browser/index.browser.js"),
        // Stub Node.js packages
        "@vercel/oidc": path.join(__dirname, "src/stubs/empty.js"),
        "dotenv": path.join(__dirname, "src/stubs/empty.js"),
        "fast-redact": path.join(__dirname, "src/stubs/fast-redact.js"),
      };
    },
  },
]);
