import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  getAppCoreSourceRoot,
  getAutonomousSourceRoot,
  getElizaCoreEntry,
  getSharedSourceRoot,
  getUiSourceRoot,
} from "../eliza-package-paths";
import { repoRoot } from "./repo-root";
import {
  getAgentSourceAliases,
  getAppCoreSourceAliases,
  getElizaWorkspaceRoot,
  getOptionalInstalledPackageAliases,
  getOptionalPluginSdkAliases,
  getSharedSourceAliases,
  getUiSourceAliases,
  getWorkspaceAppAliases,
  type ModuleAlias,
} from "./workspace-aliases";

const elizaCoreEntry = getElizaCoreEntry(repoRoot);
const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
const autonomousSourceRoot = getAutonomousSourceRoot(repoRoot);
const appCoreSourceRoot = getAppCoreSourceRoot(repoRoot);
const sharedSourceRoot = getSharedSourceRoot(repoRoot);
const workspaceUiSourceRoot = path.join(
  elizaWorkspaceRoot,
  "packages",
  "ui",
  "src",
);
const uiSourceRoot = existsSync(path.join(workspaceUiSourceRoot, "index.ts"))
  ? workspaceUiSourceRoot
  : getUiSourceRoot(repoRoot);
const integrationResolveAlias: ModuleAlias[] = [
  ...getOptionalPluginSdkAliases(repoRoot),
  ...(elizaCoreEntry
    ? [
        // Exact-match aliases only. A bare string alias prefix-matches
        // subpath imports, so "@elizaos/core/node" would rewrite to
        // "<core entry file>/node" (ENOTDIR) and the personal-assistant
        // plugin graph could not load (plugin-calendly's dist imports
        // "@elizaos/core/node") — see #11047. Pin the src entries for the
        // root and the node/browser subpaths; every other subpath
        // (./roles, ./testing, ./services/*) falls through to the package
        // exports map.
        {
          find: /^@elizaos\/core\/node$/,
          replacement: path.join(
            elizaWorkspaceRoot,
            "packages",
            "core",
            "src",
            "index.node.ts",
          ),
        },
        {
          find: /^@elizaos\/core\/browser$/,
          replacement: path.join(
            elizaWorkspaceRoot,
            "packages",
            "core",
            "src",
            "index.browser.ts",
          ),
        },
        {
          find: /^@elizaos\/core$/,
          replacement: elizaCoreEntry,
        },
      ]
    : []),
  ...getAgentSourceAliases(autonomousSourceRoot),
  ...getAppCoreSourceAliases(appCoreSourceRoot),
  ...getUiSourceAliases(uiSourceRoot),
  ...getWorkspaceAppAliases(repoRoot, [
    "app-companion",
    "plugin-personal-assistant",
    "app-task-coordinator",
    "plugin-workflow",
    "plugin-shopify",
  ]),
  ...getSharedSourceAliases(sharedSourceRoot),
  ...getOptionalInstalledPackageAliases(repoRoot, [
    {
      find: "@elizaos/plugin-signal",
      packageName: "@elizaos/plugin-signal",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-signal",
          "typescript",
          "src",
          "index",
        ),
      },
    },
    {
      find: "@elizaos/plugin-sql",
      packageName: "@elizaos/plugin-sql",
      options: {
        entryKind: "node",
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-sql",
          "typescript",
          "index.node",
        ),
      },
    },
    {
      find: "@elizaos/plugin-whatsapp",
      packageName: "@elizaos/plugin-whatsapp",
      options: {
        fallbackPath: path.join(
          elizaWorkspaceRoot,
          "plugins",
          "plugin-whatsapp",
          "typescript",
          "src",
          "index",
        ),
      },
    },
  ]),
];

export default defineConfig({
  // Anchor every relative test path at the eliza workspace root detected from
  // this config file's location. The paths used to be "eliza/"-prefixed and
  // cwd-relative, which only resolved from a consumer workspace that nests
  // the checkout as literally `eliza/` — in a flat eliza checkout or a git
  // worktree the lane found zero files (#11047).
  root: elizaWorkspaceRoot,
  resolve: {
    alias: integrationResolveAlias,
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    globalSetup: ["packages/app-core/test/e2e-global-setup.ts"],
    // Integration files frequently replace globals and module-level mocks.
    // Shared module state causes cross-file bleed, which is more expensive to
    // debug than the small cost of per-file isolation.
    isolate: true,
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    // Match the unit test worker heap to avoid late jsdom OOM crashes during
    // serial runs, where one fork accumulates dozens of suites.
    execArgv: ["--max-old-space-size=4096"],
    sequence: {
      concurrent: false,
      shuffle: false,
    },
    include: [
      "packages/agent/test/**/*.integration.test.ts",
      "apps/*/test/**/*.integration.test.ts",
      "packages/app-core/test/**/*.integration.test.ts",
      // Plugin-level integration tests (16 *.integration.test.ts files in
      // app-lifeops/test/) were dead in CI — neither the plugin's own
      // vitest.config.ts (which excludes the integration suffix from the
      // unit lane) nor this integration config picked them up. Include
      // them now so the existing coverage runs.
      "plugins/plugin-personal-assistant/test/**/*.integration.test.ts",
      "plugins/*/test/**/*.integration.test.ts",
      // Src-level plugin integration tests were dead the same way: the
      // scheduler suite at plugin-personal-assistant/src/lifeops/
      // scheduled-task/scheduler.integration.test.ts (10 real-DB tests of the
      // production processDueScheduledTasks wiring) matched neither the
      // plugin's unit lane (integration suffix excluded) nor the test/**
      // globs above — vitest reported "No test files found" even when the
      // file was passed explicitly. Include src/** so the suite runs.
      "plugins/plugin-personal-assistant/src/**/*.integration.test.ts",
      "plugins/*/src/**/*.integration.test.ts",
    ],
    setupFiles: ["packages/app-core/test/setup.ts"],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*-live.test.ts",
      "**/*-live.test.tsx",
      "**/*.live.test.ts",
      "**/*.live.test.tsx",
      "**/*-live.e2e.test.ts",
      "**/*-live.e2e.test.tsx",
      "**/*.live.e2e.test.ts",
      "**/*.live.e2e.test.tsx",
      "**/*.real.e2e.test.ts",
      "**/*.real.e2e.test.tsx",
      // --- server/runtime route tests must live in the live/real lane ---
      "packages/app-core/src/api/**/*.test.{ts,tsx}",
      "packages/app-core/src/services/**/*.test.{ts,tsx}",
      "apps/*/src/**/*routes.test.{ts,tsx}",
      "apps/*/src/services/**/*.test.{ts,tsx}",
    ],
    server: {
      deps: {
        inline: [
          "@elizaos/core",
          "@elizaos/agent",
          /^@elizaos\/app-/,
          /^@elizaos\/plugin-/,
          "zod",
        ],
      },
    },
  },
});
