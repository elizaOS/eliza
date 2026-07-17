/**
 * Vitest config for the plugin-root harness lane (`__tests__/*.harness.test.ts`).
 *
 * The changed-file coverage gate excludes `*.real.test.ts` by filename, but this
 * plugin's real suites are hermetic (in-process PGlite via
 * `createIsolatedTestDatabase`, no network, no credentials) and are the only
 * tests that exercise the adapter for real. The harness lane composes them into
 * a coverage-gate-runnable file without re-adding them to the default PR lane:
 * the package config at `src/vitest.config.ts` never sees plugin-root
 * `__tests__/`, and `run-changed-vitest-coverage.mjs` prefers this config for
 * `.harness.test.ts` files.
 *
 * Source aliases are required because the gate runs before workspace builds —
 * the suites import `@elizaos/core`, which has no dist yet at that point.
 */
import { defineConfig } from "vitest/config";
import { buildHarnessSourceAliases } from "../../packages/test/harness/source-aliases.ts";

export default defineConfig({
  test: {
    environment: "node",
    include: ["__tests__/**/*.harness.test.ts"],
    exclude: ["dist/**", "**/node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    fileParallelism: false,
  },
  resolve: {
    alias: buildHarnessSourceAliases(),
  },
});
