import { defineConfig } from "vitest/config";

/**
 * Vitest lane for cloud/shared suites that require the Vitest-only module-mock
 * API (`vi.mock` + `vi.importActual`), which bun-test's `vi` shim does not
 * implement. The bun `test:cloud` lane picks these files up but they gate to
 * `describe.skip` under bun (see `SUPPORTS_VITEST_MOCK_API`), so without this
 * lane the direct-wallet payer/state-machine proof (33 tests) never runs
 * anywhere — a vacuous skip on the crypto-payments money path. This config
 * runs it for real against in-process PGlite.
 *
 * `default-eliza-character.test.ts` is also listed: it imports from "vitest",
 * so the changed-file coverage lane (run-changed-vitest-coverage.mjs) routes
 * it through this config whenever a PR touches it. Vitest treats CLI file
 * arguments as filters against `include`, so a file absent from `include` can
 * never match — the lane exits "No test files found" (code 1) and hard-fails
 * the coverage gate for any PR touching that test. It already runs under the
 * bun lane; double execution is the only cost of listing it here.
 *
 * Do NOT set `passWithNoTests`: if the include glob ever matches nothing, the
 * lane must red rather than silently pass.
 */
export default defineConfig({
  test: {
    include: [
      "src/lib/services/__tests__/direct-wallet-payments.integration.test.ts",
      "src/lib/utils/default-eliza-character.test.ts",
    ],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Each suite pins DATABASE_URL/TEST_DATABASE_URL to pglite://memory at module
    // load; mirror it here so the proof owns its DB even if the lane exports a
    // real postgres URL.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "pglite://memory",
      TEST_DATABASE_URL: "pglite://memory",
      MOCK_REDIS: "1",
    },
  },
});
