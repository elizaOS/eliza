/** Vitest config for plugin-x402: node environment, 60s timeouts, shared core mock setup. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["./src/__tests__/core-test-mock.ts"],
  },
});
