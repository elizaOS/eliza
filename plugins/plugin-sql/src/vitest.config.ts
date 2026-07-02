import { defineConfig } from "vitest/config";

// The runner (packages/scripts/run-all-tests.mjs) drives lanes via env:
// TEST_LANE=pr sets VITEST_EXCLUDE_REAL=1, TEST_LANE=post-merge clears it so
// "real keys flow through". This config used to hard-exclude *.real.test.ts
// regardless, so the self-contained real-PGlite suites
// (runtime-migrator.real.test.ts, pglite-adapter.real.test.ts, …) ran in NO
// lane at all — the post-merge lane silently skipped them (#10104 audit).
const excludeReal =
  process.env.VITEST_EXCLUDE_REAL === "1" || process.env.VITEST_LANE !== "post-merge";

export default defineConfig({
  test: {
    include: ["**/*.test.ts", "**/*.spec.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/__tests__/e2e/**",
      "**/*.live.test.ts",
      ...(excludeReal ? ["**/*.real.test.ts", "**/*.real.e2e.test.ts"] : []),
      "**/*.e2e.test.ts",
    ],
    // Increase timeout for hooks that need to close database connections
    hookTimeout: 60000,
    // Increase test timeout for database operations (migration tests are slow)
    testTimeout: 120000,
    // Use forks pool for better test isolation
    pool: "forks",
    // Vitest 4.x moved pool options to top level
    isolate: true,
    fileParallelism: false,
    // Allow retries for flaky database tests
    retry: 1,
    // Reduce log noise
    reporters: process.env.CI ? ["verbose"] : ["default"],
    // Increase global test suite timeout
    testNamePattern: undefined,
  },
});
