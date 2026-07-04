/**
 * Vitest configuration for todos action, provider, and view tests with Node
 * resolution conditions.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["node"],
  },
  ssr: {
    resolve: {
      conditions: ["node"],
    },
  },
  test: {
    environment: "node",
    include: [
      "__tests__/**/*.{test,spec}.{ts,tsx}",
      "src/**/*.{test,spec}.{ts,tsx}",
      "test/**/*.{test,spec}.{ts,tsx}",
    ],
    testTimeout: 15_000,
    pool: "forks",
    server: {
      deps: {
        inline: ["@elizaos/core"],
      },
    },
  },
});
