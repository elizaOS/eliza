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
import {
  getAppCoreSourceRoot,
  getAutonomousSourceRoot,
  getElizaCoreEntry,
  getSharedSourceRoot,
  getUiSourceRoot,
} from "@elizaos/testing/eliza-package-paths";
import { defineConfig } from "vitest/config";
import { coverageSummaryReporters } from "../../app/scripts/coverage-policy.mjs";
import { dependencySourcemapLoggerPlugin } from "./dependency-sourcemap-logger";
import { repoRoot } from "./repo-root";
import { buildWorkspaceSourceAliases } from "./source-aliases";
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
  "plugin-anthropic",
  "plugin-assistant",
  "plugin-browser",
  "plugin-native-inference",
  "plugin-coding-tools",
  "plugin-computeruse",
  "plugin-native-contacts",
  "plugin-discord",
  "plugin-elizacloud",
  "plugin-health",
  "plugin-imessage",
  "plugin-inbox",
  "plugin-local-inference",
  "plugin-mcp",
  "plugin-native-filesystem",
  "plugin-openai",
  "plugin-native-phone",
  "plugin-pty",
  "plugin-scheduling",
  "plugin-video",
  "plugin-vision",
  "plugin-native-wifi",
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
  "@elizaos/agent",
  "@elizaos/app",
  "react",
  "react-dom",
  "react-test-renderer",
  /^@elizaai\/shared/,
  /^@elizaos\/plugin-/,
  /^@elizaos\/app-/,
  /^@elizaos\/shared/,
  "zod",
];

const vitestResolveAlias: ModuleAlias[] = buildWorkspaceSourceAliases(repoRoot);

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
      // app src-colocated tests run here; real-runtime suites run in
      // the app-unit config (apps/app/vitest.config.ts) which provides the
      // correct @elizaos/app alias resolution. Running both in parallel
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
    setupFiles: [path.join(elizaWorkspaceRoot, "packages/app/test/setup.ts")],
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
