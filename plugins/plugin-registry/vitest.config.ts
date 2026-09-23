import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    conditions: ["eliza-source", "node"],
    alias: {
      "@elizaos/core": new URL(
        "../../packages/core/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
