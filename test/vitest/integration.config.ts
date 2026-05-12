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
        {
          find: "@elizaos/core",
          replacement: elizaCoreEntry,
        },
      ]
    : []),
  ...getAgentSourceAliases(autonomousSourceRoot),
  ...getAppCoreSourceAliases(appCoreSourceRoot),
  ...getUiSourceAliases(uiSourceRoot),
  ...getWorkspaceAppAliases(repoRoot, [
    "app-companion",
    "app-lifeops",
    "app-task-coordinator",
    "app-vincent",
    "app-shopify",
    "app-steward",
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
  resolve: {
    alias: integrationResolveAlias,
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    globalSetup: ["eliza/packages/app-core/test/e2e-global-setup.ts"],
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
      "eliza/packages/agent/test/**/*.integration.test.ts",
      "eliza/apps/*/test/**/*.integration.test.ts",
      "eliza/packages/app-core/test/**/*.integration.test.ts",
      // Plugin-level integration tests (16 *.integration.test.ts files in
      // app-lifeops/test/) were dead in CI — neither the plugin's own
      // vitest.config.ts (which excludes the integration suffix from the
      // unit lane) nor this integration config picked them up. Include
      // them now so the existing coverage runs.
      "eliza/plugins/app-lifeops/test/**/*.integration.test.ts",
      "eliza/plugins/*/test/**/*.integration.test.ts",
    ],
    setupFiles: ["eliza/packages/app-core/test/setup.ts"],
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
      "eliza/packages/app-core/src/api/**/*.test.{ts,tsx}",
      "eliza/packages/app-core/src/services/**/*.test.{ts,tsx}",
      "eliza/apps/*/src/**/*routes.test.{ts,tsx}",
      "eliza/apps/*/src/services/**/*.test.{ts,tsx}",
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
