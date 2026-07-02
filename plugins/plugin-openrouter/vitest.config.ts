import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 60000,
    testTimeout: 60000,
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    // `*.harness.test.ts` boot a real PGLite runtime and need the workspace
    // source aliases from vitest.harness.config.ts — run via `test:harness`.
    // #9310 §E: the guarded models.live suite (self-skips keyless) is
    // invocable only in the post-merge lane, where run-all-tests.mjs prints
    // a named skip accounting; the unguarded native-plumbing live file stays
    // excluded in every lane.
    exclude: [
      ...(process.env.VITEST_LANE === "post-merge"
        ? ["__tests__/native-plumbing.live.test.ts"]
        : ["**/*.live.test.ts"]),
      "**/*.harness.test.ts",
    ],
    // Run test files sequentially to avoid shared state issues
    sequence: {
      shuffle: false,
    },
    // Isolate test files
    isolate: true,
    fileParallelism: false,
    // Redirect PGlite data dir to OS temp so :memory: artifacts
    // never land in the working tree (they cause Windows git failures)
    env: {
      PGDATA: join(tmpdir(), "plugin-openrouter-test-pgdata"),
    },
  },
});
