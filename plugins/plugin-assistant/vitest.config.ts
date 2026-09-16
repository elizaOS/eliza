import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    conditions: ["eliza-source", "node"],
    alias: {
      "@elizaos/shared/log-redaction": new URL(
        "../../packages/shared/src/log-redaction.ts",
        import.meta.url,
      ).pathname,
      "@elizaos/core": new URL(
        "../../packages/core/src/index.node.ts",
        import.meta.url,
      ).pathname,
      "@elizaos/plugin-assistant": new URL("./src/index.ts", import.meta.url)
        .pathname,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/*.live.test.ts",
      "**/*.real.test.ts",
      "**/*.e2e.test.ts",
      "**/dist/**",
      "**/node_modules/**",
    ],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
