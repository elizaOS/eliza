import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    globals: true,
    environment: "node",
    testTimeout: 30000,
  },
  resolve: {
    alias: {
      // @elizaos/core's package.json exports point at dist/* which is not
      // built in a fresh workspace. Vitest can resolve the source directly.
      "@elizaos/core": path.resolve(__dirname, "../../packages/core/src/index.node.ts"),
      "@elizaos/logger": path.resolve(__dirname, "../../packages/logger/src/index.ts"),
    },
  },
});
