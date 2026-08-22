/**
 * Test naming convention:
 *
 * *.test.ts            — Unit tests (run by this config / turbo test)
 * *.integration.test.ts — Integration tests (run by integration.config)
 * *.e2e.test.ts        — E2E tests (run by e2e.config)
 * *.real.test.ts       — Real infra tests (run by real.config, needs env vars)
 * *.live.test.ts       — Live tests (run by real.config, needs running services)
 * *.live.e2e.test.ts   — Live E2E (run by live-e2e.config, needs services + env)
 * *.real.e2e.test.ts   — Real E2E (run by e2e.config, needs env vars)
 * *.spec.ts            — Playwright specs (run by playwright configs)
 *
 * Test locations: src/, __tests__/, test/ — all are auto-discovered.
 * Cloud subsystems use their own runners.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { coverageSummaryReporters } from "../../app-core/scripts/coverage-policy.mjs";
import {
  getAppCoreSourceRoot,
  getAutonomousSourceRoot,
  getElizaCoreEntry,
  getSharedSourceRoot,
  getUiSourceRoot,
} from "../../core/src/testing/eliza-package-paths";
import { dependencySourcemapLoggerPlugin } from "./dependency-sourcemap-logger";
import { repoRoot } from "./repo-root";
import {
  getAgentSourceAliases,
  getAppCoreBridgeStubPath,
  getAppCoreModuleFallbackPath,
  getAppCorePluginFallbackPath,
  getAppCoreSourceAliases,
  getElizaWorkspaceRoot,
  getOptionalInstalledPackageAliases,
  getOptionalPluginSdkAliases,
  getSharedSourceAliases,
  getUiSourceAliases,
  getWorkspaceAppAliases,
  getWorkspacePluginAliases,
  type ModuleAlias,
} from "./workspace-aliases";

interface RootPackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
const elizaCoreEntry = getElizaCoreEntry(repoRoot);
const autonomousSourceRoot = getAutonomousSourceRoot(repoRoot);
const appCoreSourceRoot = getAppCoreSourceRoot(repoRoot);
const sharedSourceRoot = getSharedSourceRoot(repoRoot);
const uiSourceRoot = getUiSourceRoot(repoRoot);
const cloudRoutingSourceRoot = path.join(
  elizaWorkspaceRoot,
  "packages/cloud/routing/src",
);
const cloudSdkSourceRoot = path.join(
  elizaWorkspaceRoot,
  "packages/cloud/sdk/src",
);
// @elizaos/logger was extracted from @elizaos/core (core's src re-exports it via
// `export * from "@elizaos/logger"`). Since core is source-aliased for tests,
// resolving that re-export needs logger source-aliased too — otherwise vitest
// falls through to logger's node_modules dist, which is not built in every test
// job and fails with "Failed to resolve entry for @elizaos/logger".
const loggerSourceEntry = path.join(
  elizaWorkspaceRoot,
  "packages/logger/src/index.ts",
);
const packageManifest: RootPackageManifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

function resolveInstalledPackageRoot(
  packageName: string,
  workspacePackageRoot = repoRoot,
): string {
  const requireFromWorkspace = createRequire(
    path.join(workspacePackageRoot, "package.json"),
  );
  return path.dirname(
    requireFromWorkspace.resolve(`${packageName}/package.json`),
  );
}

// Bun isolates workspace-only development dependencies on clean installs.
// Resolve each singleton from the package that declares it rather than relying
// on an incidental root hoist that disappears when the lockfile is rebuilt.
const uiPackageRoot = path.join(elizaWorkspaceRoot, "packages", "ui");
const corePackageRoot = path.join(elizaWorkspaceRoot, "packages", "core");
const workspaceReactDir = resolveInstalledPackageRoot("react", uiPackageRoot);
const workspaceReactDomDir = resolveInstalledPackageRoot(
  "react-dom",
  uiPackageRoot,
);
const workspaceReactTestRendererDir = resolveInstalledPackageRoot(
  "react-test-renderer",
  corePackageRoot,
);
const workspaceAdzeDir = resolveInstalledPackageRoot("adze", corePackageRoot);
const workspaceReactEntry = path.join(workspaceReactDir, "index.js");
const workspaceReactJsxRuntimeEntry = path.join(
  workspaceReactDir,
  "jsx-runtime.js",
);
const workspaceReactJsxDevRuntimeEntry = path.join(
  workspaceReactDir,
  "jsx-dev-runtime.js",
);
const workspaceReactDomEntry = path.join(workspaceReactDomDir, "index.js");
const workspaceReactDomClientEntry = path.join(
  workspaceReactDomDir,
  "client.js",
);
const workspaceReactDomServerEntry = path.join(
  workspaceReactDomDir,
  "server.js",
);
const workspaceReactDomTestUtilsEntry = path.join(
  workspaceReactDomDir,
  "test-utils.js",
);
const workspaceReactTestRendererEntry = path.join(
  workspaceReactTestRendererDir,
  "index.js",
);
const workspaceAdzeEntry = path.join(workspaceAdzeDir, "dist", "index.js");
// Vite's `/@fs/` protocol expects a POSIX, forward-slash absolute path. On
// POSIX `path.join(...)` already yields `/abs/...` so `/@fs` + that gives
// `/@fs/abs/...`. On Windows it yields `C:\abs\...` (backslashes, no leading
// slash), so a naive `/@fs${p}` produces `/@fsC:\abs\...` which vite's
// `/@fs/`-prefix check never matches → "Cannot find package". Normalize
// backslashes to `/` and ensure exactly one separator after `/@fs`.
const asViteFsPath = (targetPath: string) =>
  `/@fs/${targetPath.split("\\").join("/").replace(/^\/+/, "")}`;
const workspacePluginPackageNames = Object.keys({
  ...(packageManifest.dependencies ?? {}),
  ...(packageManifest.devDependencies ?? {}),
})
  .filter((packageName) => packageName.startsWith("@elizaos/plugin-"))
  .sort();
const resolvedPluginNames = new Set<string>();
const elizaPluginAliases = workspacePluginPackageNames.flatMap(
  (packageName) => {
    const aliases = getOptionalInstalledPackageAliases(repoRoot, [
      {
        find: `${packageName}/node`,
        packageName,
        options: {
          entryKind: "node",
        },
      },
      {
        find: packageName,
        packageName,
      },
    ]);

    if (aliases.some((alias) => alias.find === packageName)) {
      resolvedPluginNames.add(packageName);
    }

    return aliases;
  },
);
const workspacePluginSourceAliases = getWorkspacePluginAliases(repoRoot, [
  "plugin-agent-orchestrator",
  "plugin-agent-skills",
  "plugin-anthropic",
  "plugin-app-control",
  "plugin-app-manager",
  "plugin-browser",
  "plugin-capacitor-bridge",
  "plugin-coding-tools",
  "plugin-commands",
  "plugin-computeruse",
  "plugin-discord",
  "plugin-elizacloud",
  "plugin-health",
  "plugin-imessage",
  "plugin-inbox",
  "plugin-local-inference",
  "plugin-mcp",
  "plugin-native-filesystem",
  "plugin-openai",
  "plugin-phone",
  "plugin-pty",
  "plugin-scheduling",
  "plugin-task-coordinator",
  "plugin-video",
  "plugin-vision",
  "plugin-whatsapp",
  "plugin-workflow",
]);
const pluginPdfSrc = path.join(elizaWorkspaceRoot, "plugins", "plugin-pdf");
// Fall back to a stub when an optional plugin tarball has a broken entry point.
const unresolvedPluginStubs = workspacePluginPackageNames
  .filter((name) => !resolvedPluginNames.has(name))
  .map((name) => ({
    find: name,
    replacement: getAppCorePluginFallbackPath(repoRoot),
  }));
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const isWindows = process.platform === "win32";
const localWorkers = 2;
const ciWorkers = isWindows ? 2 : 3;
const appCoreModuleFallbackPath = getAppCoreModuleFallbackPath(repoRoot);
const appCoreBridgeStubPath = getAppCoreBridgeStubPath(repoRoot);
const appCorePluginFallbackPath = getAppCorePluginFallbackPath(repoRoot);
const vitestInlineDeps = [
  "@testing-library/react",
  "@elizaos/core",
  "@elizaos/logger",
  "@elizaos/agent",
  "@elizaos/app-core",
  "react",
  "react-dom",
  "react-test-renderer",
  /^@elizaai\/shared/,
  /^@elizaos\/plugin-/,
  /^@elizaos\/app-/,
  /^@elizaos\/shared/,
  "zod",
];

const vitestResolveAlias: ModuleAlias[] = [
  {
    // Resolve @elizaos/logger to source (it is re-exported by source-aliased
    // @elizaos/core); avoids depending on logger's dist being built per test job.
    find: /^@elizaos\/logger$/,
    replacement: loggerSourceEntry,
  },
  {
    // Keep React pinned to one installed copy so jsdom does not mix workspace and hoisted peers.
    find: /^react$/,
    replacement: asViteFsPath(workspaceReactEntry),
  },
  {
    find: /^react\/jsx-runtime$/,
    replacement: asViteFsPath(workspaceReactJsxRuntimeEntry),
  },
  {
    find: /^react\/jsx-dev-runtime$/,
    replacement: asViteFsPath(workspaceReactJsxDevRuntimeEntry),
  },
  {
    find: /^react\/(.*)$/,
    replacement: asViteFsPath(path.join(workspaceReactDir, "$1")),
  },
  {
    find: /^react-dom$/,
    replacement: asViteFsPath(workspaceReactDomEntry),
  },
  {
    find: /^react-dom\/client$/,
    replacement: asViteFsPath(workspaceReactDomClientEntry),
  },
  {
    find: /^react-dom\/server$/,
    replacement: asViteFsPath(workspaceReactDomServerEntry),
  },
  {
    find: /^react-dom\/test-utils$/,
    replacement: asViteFsPath(workspaceReactDomTestUtilsEntry),
  },
  {
    find: /^react-dom\/(.*)$/,
    replacement: asViteFsPath(path.join(workspaceReactDomDir, "$1")),
  },
  {
    find: /^react-test-renderer$/,
    replacement: asViteFsPath(workspaceReactTestRendererEntry),
  },
  {
    find: /^react-test-renderer\/(.*)$/,
    replacement: asViteFsPath(path.join(workspaceReactTestRendererDir, "$1")),
  },
  {
    find: /^adze$/,
    replacement: asViteFsPath(workspaceAdzeEntry),
  },
  {
    find: /^adze\/(.*)$/,
    replacement: asViteFsPath(path.join(workspaceAdzeDir, "$1")),
  },
  {
    find: /^@elizaos\/plugin-sql$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins/plugin-sql/src/index.node.ts",
    ),
  },
  // Leaf auth package (account storage, credentials, oauth flows, atomic-json).
  // Sits below @elizaos/agent and @elizaos/app-core; source-aliased here so every
  // base-config consumer resolves it without needing its dist built.
  {
    find: /^@elizaos\/auth$/,
    replacement: path.join(elizaWorkspaceRoot, "packages/auth/src/index.ts"),
  },
  {
    find: /^@elizaos\/auth\/(.+)$/,
    replacement: path.join(elizaWorkspaceRoot, "packages/auth/src/$1"),
  },
  // Server-safe DB subpaths of the carved LifeOps plugins. PA's
  // lifeops/repository.ts imports its schemas/repos/factories from these leaf
  // modules (not the package barrels, which re-export React views → @elizaos/ui).
  // The `./*` wildcard export is skipped by the auto-alias builder, so anchor the
  // exact subpaths to source here for every base-config consumer.
  {
    find: /^@elizaos\/plugin-inbox\/db\/schema$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins/plugin-inbox/src/db/schema.ts",
    ),
  },
  {
    find: /^@elizaos\/plugin-finances\/db\/finances-repository$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins/plugin-finances/src/db/finances-repository.ts",
    ),
  },
  {
    find: /^@elizaos\/plugin-health\/health-bridge\/health-records$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins/plugin-health/src/health-bridge/health-records.ts",
    ),
  },
  {
    find: /^@elizaos\/plugin-health\/sleep\/sleep-episode-types$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins/plugin-health/src/sleep/sleep-episode-types.ts",
    ),
  },
  {
    find: /^@elizaos\/plugin-browser\/schema$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins/plugin-browser/src/schema.ts",
    ),
  },
  {
    find: /^@elizaos\/cloud-routing$/,
    replacement: path.join(cloudRoutingSourceRoot, "index.ts"),
  },
  {
    find: /^@elizaos\/cloud-sdk$/,
    replacement: path.join(cloudSdkSourceRoot, "index.ts"),
  },
  {
    find: /^@elizaos\/vault$/,
    replacement: path.join(elizaWorkspaceRoot, "packages/vault/src/index.ts"),
  },
  {
    // App-core tests mock this plugin, but Vitest still has to resolve the specifier.
    find: "@elizaos/capacitor-agent",
    replacement: appCoreModuleFallbackPath,
  },
  {
    find: "@elizaos/capacitor-llama",
    replacement: path.join(
      elizaWorkspaceRoot,
      "packages",
      "native-plugins",
      "llama",
      "src",
      "index.ts",
    ),
  },
  {
    find: "@elizaos/plugin-telegram",
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "plugin-telegram",
      "src",
      "index.ts",
    ),
  },
  {
    find: "@elizaos/scenario-runner/schema",
    replacement: path.join(
      elizaWorkspaceRoot,
      "packages",
      "scenario-schema",
      "index.js",
    ),
  },
  {
    find: /^@elizaos\/plugin-pdf$/,
    replacement: path.join(pluginPdfSrc, "index.node.ts"),
  },
  ...workspacePluginSourceAliases,
  ...getOptionalPluginSdkAliases(repoRoot),
  ...(elizaCoreEntry
    ? [
        {
          // Resolve the testing subpath to source before the broad
          // `@elizaos/core` alias, which would otherwise treat the source
          // entry file as a directory (`index.node.ts/testing` → ENOTDIR).
          find: /^@elizaos\/core\/testing$/,
          replacement: path.join(
            path.dirname(elizaCoreEntry),
            "testing/index.ts",
          ),
        },
        {
          // Scheduling's source runner imports the edge-safe serializer. Keep
          // this exports-map subpath ahead of the prefix-matching bare alias so
          // clean package tests never resolve `index.node.ts/edge` (ENOTDIR).
          find: /^@elizaos\/core\/edge$/,
          replacement: path.join(
            path.dirname(elizaCoreEntry),
            elizaCoreEntry.endsWith(".ts")
              ? "index.edge.ts"
              : "edge/index.edge.js",
          ),
        },
        {
          // Same story for the atomic-json subpath (agent's
          // app-package-modules imports it directly).
          find: /^@elizaos\/core\/atomic-json$/,
          replacement: path.join(
            path.dirname(elizaCoreEntry),
            elizaCoreEntry.endsWith(".ts")
              ? "utils/atomic-json.ts"
              : "utils/atomic-json.js",
          ),
        },
        {
          // The client-public entry is bundled separately from the core root.
          // Resolve it before the prefix-matching bare-core alias below so
          // package tests do not produce index.node.ts/client-public (ENOTDIR).
          find: /^@elizaos\/core\/client-public$/,
          replacement: path.join(
            path.dirname(elizaCoreEntry),
            elizaCoreEntry.endsWith(".ts")
              ? "client-public.ts"
              : "client-public.js",
          ),
        },
        {
          find: /^@elizaos\/core\/security\/kms$/,
          replacement: path.join(
            path.dirname(elizaCoreEntry),
            elizaCoreEntry.endsWith(".ts")
              ? "security/kms/index.ts"
              : "security/kms/index.js",
          ),
        },
        {
          // Single-file security subpaths (network-policy,
          // mcp-server-config, …) map 1:1 onto files next to the entry.
          find: /^@elizaos\/core\/security\/([^/]+)$/,
          replacement: path.join(
            path.dirname(elizaCoreEntry),
            elizaCoreEntry.endsWith(".ts")
              ? "security/$1.ts"
              : "security/$1.js",
          ),
        },
        {
          find: "@elizaos/core",
          replacement: elizaCoreEntry,
        },
        ...elizaPluginAliases,
        ...unresolvedPluginStubs,
      ]
    : []),
  ...(autonomousSourceRoot
    ? getAgentSourceAliases(autonomousSourceRoot)
    : getAgentSourceAliases(undefined, {
        // Stub missing @elizaos/agent subpaths so transitive imports keep resolving.
        fallbackReplacement: appCoreModuleFallbackPath,
      })),
  ...getAppCoreSourceAliases(appCoreSourceRoot, {
    bridgeReplacement: appCoreBridgeStubPath,
    fallbackReplacement: appCorePluginFallbackPath,
    stubRootSpecifier: true,
  }),
  ...getWorkspaceAppAliases(repoRoot, [
    "plugin-personal-assistant",
    "plugin-documents",
    "plugin-wallet",
  ]),
  ...getSharedSourceAliases(sharedSourceRoot, {
    includeElizaAlias: true,
  }),
  ...getUiSourceAliases(uiSourceRoot),
];

export default defineConfig({
  plugins: [dependencySourcemapLoggerPlugin()],
  resolve: {
    preserveSymlinks: true,
    dedupe: ["react", "react-dom", "ethers", "@elizaos/core"],
    alias: vitestResolveAlias,
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: isCI ? 300_000 : isWindows ? 180_000 : 120_000,
    pool: "forks",
    maxWorkers: isCI ? ciWorkers : localWorkers,
    restoreMocks: true,
    // Some shard patterns (for example packages/agent/test) hold only test
    // infrastructure, not *.test.ts files. Tolerate empty matches so those
    // shards pass instead of aborting the whole suite.
    passWithNoTests: true,
    // Give worker forks more heap to survive jsdom-heavy suites.
    execArgv: ["--max-old-space-size=4096"],
    include: [
      // Keep this list explicit. New root/eliza package tests do not auto-join
      // the default suite; add them here when that package is meant to run in
      // the shared root Vitest job. apps/app test/vite/** lives under
      // apps/app/vitest.config.ts instead of this root config.
      // app-core src-colocated tests run here; real-runtime suites run in
      // the app-unit config (apps/app/vitest.config.ts) which provides the
      // correct @elizaos/app-core alias resolution. Running both in parallel
      // causes file-system race conditions on shared test fixtures.
      // Keep the standalone-safe Electrobun tests in the default unit suite.
      // native/agent.test.ts requires the full desktop runtime, so it runs only
      // via the package-owned desktop contract command during release review;
      // routine CI does not duplicate that platform-specific lane.
      "src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,tsx}",
      "apps/chrome-extension/**/*.test.ts",
      "apps/chrome-extension/**/*.test.tsx",
    ],
    setupFiles: [
      path.join(elizaWorkspaceRoot, "packages/app-core/test/setup.ts"),
    ],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      ".claude/**",
      // --- live/real/integration/e2e tests have their own configs ---
      "**/*-live.test.{ts,tsx}",
      "**/*.live.test.{ts,tsx}",
      "**/*-real.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.integration.test.{ts,tsx}",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.live.e2e.test.{ts,tsx}",
      "**/*.real.e2e.test.{ts,tsx}",
      // --- server/runtime route tests must live in the live/real lane ---
      // --- subsystems with their own test runners ---
      // --- wired via turbo, not root vitest ---
      // Template plugin tests need a scaffolded environment to run.
      // Skills tests use their own package-level runner.
      // Homepage tests need jsdom environment (run via packages/homepage vitest config).
      "packages/homepage/**",
    ],
    coverage: {
      provider: "v8",
      reporter: [...coverageSummaryReporters],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Entrypoints and wiring are covered by CI smoke and e2e flows.
        "src/entry.ts",
        "src/index.ts",
        "src/cli/**",
        "src/hooks/**",
        // Rolldown coverage still struggles with these inline type-import files.
      ],
    },
    server: {
      deps: {
        inline: vitestInlineDeps,
      },
    },
  },
});
