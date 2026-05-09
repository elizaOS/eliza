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
 * Subsystems with their own runners: eliza/cloud,
 * eliza/packages/examples, eliza/packages/benchmarks.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";
import {
  coverageSummaryReporters,
  coverageThresholds,
} from "../../packages/app-core/scripts/coverage-policy.mjs";
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
  getAppCoreBridgeStubPath,
  getAppCoreModuleFallbackPath,
  getAppCorePluginFallbackPath,
  getAppCoreSourceAliases,
  getElizaCoreRolesEntry,
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
const elizaCoreRolesEntry = getElizaCoreRolesEntry(repoRoot);
const autonomousSourceRoot = getAutonomousSourceRoot(repoRoot);
const appCoreSourceRoot = getAppCoreSourceRoot(repoRoot);
const sharedSourceRoot = getSharedSourceRoot(repoRoot);
const uiSourceRoot = getUiSourceRoot(repoRoot);
const packageManifest: RootPackageManifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);

function resolveInstalledPackageRoot(packageName: string): string {
  const manifestCandidates = [
    path.join(repoRoot, "package.json"),
    path.join(elizaWorkspaceRoot, "package.json"),
    path.join(elizaWorkspaceRoot, "packages", "app", "package.json"),
    path.join(elizaWorkspaceRoot, "packages", "app-core", "package.json"),
    path.join(elizaWorkspaceRoot, "packages", "ui", "package.json"),
  ];

  for (const manifestPath of manifestCandidates) {
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const requireFromManifest = createRequire(manifestPath);
      return path.dirname(
        requireFromManifest.resolve(`${packageName}/package.json`),
      );
    } catch {
      // Try the next workspace manifest.
    }
  }

  return path.join(repoRoot, "node_modules", packageName);
}

const workspaceReactDir = resolveInstalledPackageRoot("react");
const workspaceReactDomDir = resolveInstalledPackageRoot("react-dom");
const workspaceReactTestRendererDir = resolveInstalledPackageRoot(
  "react-test-renderer",
);
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
const asViteFsPath = (targetPath: string) => `/@fs${targetPath}`;
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
  "plugin-agent-skills",
  "plugin-browser",
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
    // `@elizaos/plugin-sql/schema` etc. resolve to TS source via the
    // package's `exports` field. Vitest's Node-style resolver inside
    // this config doesn't honour those, so map sub-paths explicitly to
    // the actual source dir. Without this, anything that transitively
    // imports `@elizaos/plugin-sql/schema` (auth-store, etc.) fails to
    // load with "Cannot find package".
    find: /^@elizaos\/plugin-sql$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins/plugin-sql/src/index.node.ts",
    ),
  },
  {
    find: /^@elizaos\/plugin-sql\/schema$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "plugin-sql",
      "typescript",
      "schema",
      "index.ts",
    ),
  },
  {
    find: /^@elizaos\/plugin-sql\/drizzle$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins/plugin-sql/src/drizzle/index.ts",
    ),
  },
  {
    find: /^@elizaos\/plugin-sql\/(.+)$/,
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins/plugin-sql/src/$1",
    ),
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
    // Transitively imported via app-lifeops; resolve to source so subpath imports work.
    find: "@elizaos/plugin-telegram/account-auth-service",
    replacement: path.join(
      elizaWorkspaceRoot,
      "plugins",
      "plugin-telegram",
      "src",
      "account-auth-service.ts",
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
    find: "@elizaos/scenario-schema",
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
  {
    find: /^@elizaos\/plugin-pdf\/(.+)$/,
    replacement: path.join(pluginPdfSrc, "$1"),
  },
  ...workspacePluginSourceAliases,
  ...getOptionalPluginSdkAliases(repoRoot),
  // Keep the roles shim here so Vitest resolves it when the local eliza checkout is absent.
  {
    find: "@elizaos/core/roles",
    replacement: elizaCoreRolesEntry,
  },
  ...(elizaCoreEntry
    ? [
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
    "app-companion",
    "app-task-coordinator",
    "app-training",
    "app-vincent",
    "app-shopify",
    "app-steward",
    "app-lifeops",
    "app-documents",
    "app-wallet",
  ]),
  ...getSharedSourceAliases(sharedSourceRoot, {
    includeElizaAlias: true,
  }),
  ...getUiSourceAliases(uiSourceRoot),
];

export default defineConfig({
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
    // Some shard patterns (e.g. eliza/packages/agent/test) hold only test
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
      "eliza/packages/agent/src/**/*.test.ts",
      "eliza/packages/agent/src/**/*.test.tsx",
      "eliza/packages/agent/test/**/*.test.ts",
      "eliza/packages/agent/test/**/*.test.tsx",
      "eliza/apps/*/test/**/*.test.ts",
      "eliza/apps/*/test/**/*.test.tsx",
      "eliza/packages/app-core/test/live-agent/**/*.test.ts",
      "eliza/packages/app-core/test/live-agent/**/*.test.tsx",
      "eliza/packages/app-core/test/helpers/**/*.test.ts",
      "eliza/test/mocks/__tests__/**/*.test.ts",
      // app-core src-colocated tests run here; test/ harness suites run in
      // the app-unit config (apps/app/vitest.config.ts) which provides the
      // correct @elizaos/app-core alias resolution. Running both in parallel
      // causes file-system race conditions on shared test fixtures.
      "eliza/packages/app-core/src/**/*.test.ts",
      // Keep the standalone-safe Electrobun tests in the default unit suite.
      // native/agent.test.ts requires the full desktop runtime, so it runs only
      // via `bun run test:desktop:contract` in `.github/workflows/test.yml`
      // (and the matching nightly desktop-contract job).
      "eliza/packages/app-core/platforms/electrobun/src/menu-reset-from-main.test.ts",
      "eliza/packages/app-core/platforms/electrobun/src/diagnostic-format.test.ts",
      "eliza/packages/app-core/platforms/electrobun/src/native/steward.test.ts",
      "eliza/packages/app-core/platforms/electrobun/src/application-menu.test.ts",
      "eliza/packages/app-core/scripts/**/*.test.ts",
      "eliza/packages/native-plugins/llama/src/**/*.test.ts",
      "eliza/packages/shared/src/**/*.test.ts",
      "eliza/plugins/plugin-browser/src/**/*.test.ts",
      "eliza/packages/app-core/src/**/*.test.tsx",
      "eliza/packages/agent/src/runtime/roles/test/**/*.test.ts",
      "eliza/plugins/app-lifeops/src/selfcontrol/**/*.test.ts",
      "eliza/plugins/app-vincent/src/**/*.test.ts",
      "eliza/plugins/app-shopify/src/**/*.test.ts",
      "eliza/plugins/app-steward/src/**/*.test.ts",
      "eliza/plugins/app-wallet/src/**/*.test.ts",
      "eliza/plugins/app-wallet/src/**/*.test.tsx",
      "eliza/plugins/app-lifeops/src/**/*.test.ts",
      "packages/plugin-wechat/src/**/*.test.ts",
      "eliza/plugins/plugin-music/src/**/*.test.ts",
      "eliza/plugins/plugin-discord/__tests__/**/*.test.ts",
      "src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.{ts,tsx}",
      "apps/chrome-extension/**/*.test.ts",
      "apps/chrome-extension/**/*.test.tsx",
      "eliza/test/helpers/**/*.test.ts",
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
      "eliza/packages/app-core/src/api/**/*.test.{ts,tsx}",
      "eliza/packages/app-core/src/services/**/*.test.{ts,tsx}",
      "eliza/apps/*/src/**/*routes.test.{ts,tsx}",
      "eliza/apps/*/src/services/**/*.test.{ts,tsx}",
      // --- subsystems with their own test runners ---
      "eliza/cloud/**",
      // --- wired via turbo, not root vitest ---
      "eliza/packages/examples/**",
      "eliza/packages/benchmarks/**",
      // Template plugin tests need a scaffolded environment to run.
      "eliza/packages/elizaos/templates/**",
      // Skills tests use their own package-level runner.
      "eliza/packages/skills/test/**",
      // Homepage tests need jsdom environment (run via packages/homepage vitest config).
      "packages/homepage/**",
      // Requires the built plugin-training dist from `bun run build`.
      "**/training-service.import-ollama.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: [...coverageSummaryReporters],
      thresholds: coverageThresholds,
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Entrypoints and wiring are covered by CI smoke and e2e flows.
        "src/entry.ts",
        "src/index.ts",
        "src/cli/**",
        "src/hooks/**",
        // Rolldown coverage still struggles with these inline type-import files.
        "eliza/packages/agent/src/api/server.ts",
        "eliza/packages/agent/src/runtime/eliza.ts",
      ],
    },
    server: {
      deps: {
        inline: vitestInlineDeps,
      },
    },
  },
});
