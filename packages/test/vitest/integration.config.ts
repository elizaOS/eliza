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
const elizaCoreEntryDir = elizaCoreEntry
  ? path.dirname(elizaCoreEntry)
  : undefined;
// Exact-match aliases for the `@elizaos/core/<subpath>` exports this lane's
// module graph imports (`./node` from plugin dists, `./testing` from the test
// harness, `./connectors` from connector plugins). Each candidate list covers
// the source layout (entry at src/) first, then the built layout (entry at
// dist/node/), so every subpath resolves inside the same core tree as
// `elizaCoreEntry` — mixing source and dist would boot two copies of core.
const elizaCoreSubpathAliases: ModuleAlias[] = elizaCoreEntryDir
  ? [
      { subpath: "node", candidates: ["index.node.ts", "index.node.js"] },
      {
        subpath: "testing",
        candidates: ["testing/index.ts", "../testing/index.js"],
      },
      {
        subpath: "connectors",
        candidates: ["connectors.ts", "../connectors.js"],
      },
    ].flatMap(({ subpath, candidates }) => {
      const replacement = candidates
        .map((candidate) => path.join(elizaCoreEntryDir, candidate))
        .find((candidate) => existsSync(candidate));
      return replacement
        ? [{ find: new RegExp(`^@elizaos/core/${subpath}$`), replacement }]
        : [];
    })
  : [];
const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
// plugin-discord is not part of build:core, so its `/user-account-scraper`
// subpath export has no dist and dies with "Cannot find package" when the PA
// plugin graph boots (discord-service.ts imports it). Its exports map carries
// an `eliza-source` condition pointing at the TS source; vite's SSR resolver
// does not honor that condition, so pin the subpath to the source file the
// same way the core subpaths are pinned above.
const discordScraperSource = path.join(
  elizaWorkspaceRoot,
  "plugins",
  "plugin-discord",
  "user-account-scraper",
  "index.ts",
);
const discordSubpathAliases: ModuleAlias[] = existsSync(discordScraperSource)
  ? [
      {
        find: /^@elizaos\/plugin-discord\/user-account-scraper$/,
        replacement: discordScraperSource,
      },
    ]
  : [];
// Include/exclude globs are cwd-relative, but the eliza workspace sits at
// `eliza/` in the nested eliza layout and at the repo root in a flat eliza
// checkout (#11047). Derive the prefix instead of hardcoding `eliza/` so the
// lane finds its test files in both layouts (a hardcoded prefix made every
// plugins/*/test/**/*.integration.test.ts glob dead in flat checkouts).
const relativeElizaRoot = path
  .relative(process.cwd(), elizaWorkspaceRoot)
  .split(path.sep)
  .join("/");
const elizaGlob = (pattern: string): string =>
  relativeElizaRoot === "" ? pattern : `${relativeElizaRoot}/${pattern}`;
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
  ...discordSubpathAliases,
  ...(elizaCoreEntry
    ? [
        // Subpath aliases must precede the bare specifier. A bare-string
        // `find` is prefix-matched by Vite/rollup, so a string
        // "@elizaos/core" alias rewrites "@elizaos/core/node" (and
        // "/testing", "/connectors") into "<core entry file>/<subpath>" — a
        // path under a *file* (ENOTDIR) — which killed every plugin
        // integration test in this lane (#11047). The bare specifier is
        // exact-matched so any other subpath falls through to normal
        // package-exports resolution instead of being rewritten.
        ...elizaCoreSubpathAliases,
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
  resolve: {
    alias: integrationResolveAlias,
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    globalSetup: [
      path.join(elizaWorkspaceRoot, "packages/app-core/test/e2e-global-setup.ts"),
    ],
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
      elizaGlob("packages/agent/test/**/*.integration.test.ts"),
      elizaGlob("apps/*/test/**/*.integration.test.ts"),
      elizaGlob("packages/app-core/test/**/*.integration.test.ts"),
      // Plugin-level integration tests (16 *.integration.test.ts files in
      // app-lifeops/test/) were dead in CI — neither the plugin's own
      // vitest.config.ts (which excludes the integration suffix from the
      // unit lane) nor this integration config picked them up. Include
      // them now so the existing coverage runs.
      elizaGlob("plugins/plugin-personal-assistant/test/**/*.integration.test.ts"),
      elizaGlob("plugins/*/test/**/*.integration.test.ts"),
      // Src-level plugin integration tests were dead the same way: the
      // scheduler suite at plugin-personal-assistant/src/lifeops/
      // scheduled-task/scheduler.integration.test.ts (10 real-DB tests of the
      // production processDueScheduledTasks wiring) matched neither the
      // plugin's unit lane (integration suffix excluded) nor the test/**
      // globs above — vitest reported "No test files found" even when the
      // file was passed explicitly. Include src/** so the suite runs.
      elizaGlob("plugins/plugin-personal-assistant/src/**/*.integration.test.ts"),
      elizaGlob("plugins/*/src/**/*.integration.test.ts"),
    ],
    setupFiles: [path.join(elizaWorkspaceRoot, "packages/app-core/test/setup.ts")],
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
      elizaGlob("packages/app-core/src/api/**/*.test.{ts,tsx}"),
      elizaGlob("packages/app-core/src/services/**/*.test.{ts,tsx}"),
      elizaGlob("apps/*/src/**/*routes.test.{ts,tsx}"),
      elizaGlob("apps/*/src/services/**/*.test.{ts,tsx}"),
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
