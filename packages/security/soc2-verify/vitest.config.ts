/**
 * Vitest configuration for the SOC2 verification harness tests.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/security": new URL("../src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
  },
});
