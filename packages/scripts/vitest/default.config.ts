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
import path from "node:path";
import { defineConfig } from "vitest/config";
import { coverageSummaryReporters } from "../../app/scripts/coverage-policy.ts";
import { dependencySourcemapLoggerPlugin } from "./dependency-sourcemap-logger";
import { repoRoot } from "./repo-root";
import { buildWorkspaceSourceAliases } from "./source-aliases";
import { getElizaWorkspaceRoot, type ModuleAlias } from "./workspace-aliases";

const elizaWorkspaceRoot = getElizaWorkspaceRoot(repoRoot);
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const isWindows = process.platform === "win32";
const localWorkers = 2;
const ciWorkers = isWindows ? 2 : 3;
const vitestInlineDeps = [
  "@testing-library/react",
  "@elizaos/core",
  "@elizaos/agent",
  "@elizaos/app",
  "react",
  "react-dom",
  "react-test-renderer",
  /^@elizaos\/plugin-/,
  /^@elizaos\/app-/,
  "zod",
];

const vitestResolveAlias: ModuleAlias[] = buildWorkspaceSourceAliases(repoRoot);

export default defineConfig({
  plugins: [dependencySourcemapLoggerPlugin()],
  resolve: {
    // Bun's isolated dependency store keeps transitive dependencies beside the
    // real package. Resolving through a workspace symlink loses that lookup root.
    preserveSymlinks: false,
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
