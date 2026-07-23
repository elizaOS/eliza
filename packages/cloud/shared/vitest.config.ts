/**
 * Vitest lane for cloud/shared suites that require the Vitest-only module-mock
 * API (`vi.doMock` + `vi.importActual`), which bun-test's `vi` shim does not
 * implement. The bun `test:cloud` lane picks these files up but they gate to
 * `describe.skip` under bun (see `SUPPORTS_VITEST_MOCK_API`), so without this
 * lane the direct-wallet payer/state-machine proof (40 tests) never runs
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

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        // Vite's SSR resolver does not consistently honor custom export
        // conditions. Pin the real node source so pre-build coverage exercises
        // PGlite instead of falling through to plugin-sql's absent dist entry.
        find: /^@elizaos\/plugin-sql$/,
        replacement: fileURLToPath(
          new URL("../../../plugins/plugin-sql/src/index.node.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    include: [
      "src/lib/services/__tests__/direct-wallet-payments.integration.test.ts",
      "src/lib/utils/default-eliza-character.test.ts",
      "src/lib/eliza/config.canonical-model-pair.test.ts",
    ],
    environment: "node",
    // PGlite's WASM worker outlives Vitest's fork shutdown grace even after
    // the database closes; the thread pool terminates the same real suite
    // cleanly without a false teardown-timeout warning.
    pool: "threads",
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
