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
    exclude: ["**/*.live.test.ts"],
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
