import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { CAPACITOR_PLUGIN_NAMES } from "./scripts/capacitor-plugin-names.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const _require = createRequire(import.meta.url);

const nativePluginsRoot = path.join(
  repoRoot,
  "eliza",
  "packages",
  "native-plugins",
);
const appCorePackageRoot = path.join(
  repoRoot,
  "eliza",
  "packages",
  "app-core",
  "src",
);
const agentSourceRoot = path.join(
  repoRoot,
  "eliza",
  "packages",
  "agent",
  "src",
);
const uiSourceRoot = path.join(repoRoot, "eliza", "packages", "ui", "src");
const bridgeStubPath = path.join(here, "test", "stubs", "app-core-bridge.ts");

const capacitorCoreEntry = _require.resolve("@capacitor/core");

const nativePluginAliasMap = Object.fromEntries(
  CAPACITOR_PLUGIN_NAMES.map((name) => [
    `@elizaos/capacitor-${name}`,
    path.join(nativePluginsRoot, `${name}/src/index.ts`),
  ]),
);

const vitestInlineDeps = [
  "@elizaos/agent",
  "@elizaos/app-core",
  "@elizaos/core",
  "@testing-library/react",
  "react",
  "react-dom",
  "react-test-renderer",
  /^@elizaos\/plugin-/,
  "zod",
];

/**
 * Redirects `@elizaos/app-core` bridge entrypoints to the test shim so the
 * unit suite never touches the real Electrobun RPC modules.
 */
function appCoreBridgeStubPlugin(): Plugin {
  const stubbed = new Set([
    "@elizaos/app-core",
    "@elizaos/app-core/bridge",
    "@elizaos/app-core/bridge/electrobun-rpc",
    "@elizaos/app-core/bridge/electrobun-runtime",
    "@elizaos/app-core/electrobun-rpc",
    "@elizaos/app-core/electrobun-runtime",
  ]);
  return {
    name: "app-core-bridge-stub",
    enforce: "pre",
    resolveId(source) {
      if (stubbed.has(source)) {
        return bridgeStubPath;
      }
      return null;
    },
  };
}

/**
 * Build aliases driven by @elizaos/app-core's package.json `exports` field
 * when the app-core source tree is available locally. This lets unit tests
 * resolve `@elizaos/app-core/<subpath>` directly to source.
 */
function buildAppCoreAliases(): Array<{ find: RegExp; replacement: string }> {
  const appCorePkgPath = path.resolve(appCorePackageRoot, "..", "package.json");
  if (!fs.existsSync(appCorePkgPath)) {
    return [];
  }
  const appCorePkg = JSON.parse(fs.readFileSync(appCorePkgPath, "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  for (const [key, value] of Object.entries(appCorePkg.exports ?? {})) {
    if (typeof value !== "string") continue;
    const aliasKey =
      key === "."
        ? "@elizaos/app-core"
        : `@elizaos/app-core/${key.replace(/^\.\//, "")}`;
    const targetPath = path.resolve(appCorePackageRoot, "..", value);
    aliases.push({
      find: new RegExp(`^${aliasKey}$`),
      replacement: targetPath,
    });
    if (!aliasKey.endsWith(".js") && !aliasKey.endsWith(".css")) {
      aliases.push({
        find: new RegExp(`^${aliasKey}\\.js$`),
        replacement: targetPath,
      });
    }
  }
  // Catch-all for sub-paths not in the explicit exports map.
  aliases.push({
    find: /^@elizaos\/app-core\/(.*)/,
    replacement: path.join(appCorePackageRoot, "$1"),
  });
  return aliases;
}

export default defineConfig({
  plugins: [appCoreBridgeStubPlugin()],
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: path.join(here, "node_modules/react"),
      },
      {
        find: /^react\/(.*)$/,
        replacement: path.join(here, "node_modules/react", "$1"),
      },
      {
        find: /^react-dom$/,
        replacement: path.join(here, "node_modules/react-dom"),
      },
      {
        find: /^react-dom\/(.*)$/,
        replacement: path.join(here, "node_modules/react-dom", "$1"),
      },
      {
        find: /^@capacitor\/core$/,
        replacement: capacitorCoreEntry,
      },
      ...(fs.existsSync(appCorePackageRoot) ? buildAppCoreAliases() : []),
      ...(fs.existsSync(agentSourceRoot)
        ? [
            {
              find: /^@elizaos\/agent\/(.*)/,
              replacement: path.join(agentSourceRoot, "$1"),
            },
          ]
        : []),
      ...(fs.existsSync(uiSourceRoot)
        ? [
            {
              find: /^@elizaos\/ui\/(.*)/,
              replacement: path.join(uiSourceRoot, "$1"),
            },
          ]
        : []),
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    exclude: [
      "test/**/*-live.test.ts",
      "test/**/*-live.test.tsx",
      "test/**/*.live.test.ts",
      "test/**/*.live.test.tsx",
      "test/**/*-live.e2e.test.ts",
      "test/**/*-live.e2e.test.tsx",
      "test/**/*.live.e2e.test.ts",
      "test/**/*.live.e2e.test.tsx",
      "test/**/*.real.e2e.test.ts",
      "test/**/*.real.e2e.test.tsx",
    ],
    setupFiles: [path.join(here, "test/setup.ts")],
    environment: "node",
    alias: {
      ...nativePluginAliasMap,
    },
    testTimeout: 30000,
    hookTimeout: 120000,
    pool: "forks",
    minWorkers: 1,
    maxWorkers: 2,
    execArgv: ["--max-old-space-size=4096"],
    globals: true,
    server: {
      deps: {
        inline: vitestInlineDeps,
      },
    },
  },
});
