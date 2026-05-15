/**
 * Local vitest config for the vision-CUA E2E harness.
 *
 * The repo-root vitest config excludes `**\/*.e2e.test.ts` from the parallel
 * unit-test suite. This package owns the E2E pipeline test, so it must opt
 * back in explicitly. Running `bun run --cwd packages/benchmarks/eliza-1/vision-cua-e2e test`
 * uses this config.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ["**/*.test.ts", "**/*.e2e.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
