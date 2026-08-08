/** Vitest config for the iMessage plugin; loads the `@elizaos/core` mock in `__tests__/core-test-mock.ts` as a setup file. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    exclude: ["dist/**", "**/node_modules/**", "**/*.live.test.ts", "**/*.e2e.test.ts"],
    setupFiles: ["./__tests__/core-test-mock.ts"],
    // Real SQLite fixture setup can exceed Vitest's 5s default while the
    // repository plugin shards contend for CPU and disk on shared CI runners.
    testTimeout: 15_000,
  },
});
