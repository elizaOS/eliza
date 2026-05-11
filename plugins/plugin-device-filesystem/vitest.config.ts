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
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 15_000,
    passWithNoTests: true,
    pool: "forks",
    server: {
      deps: {
        inline: ["@elizaos/core"],
      },
    },
  },
});
