import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/core": fileURLToPath(
        new URL("../../packages/core/src/index.node.ts", import.meta.url)
      ),
      "@elizaos/plugin-local-inference": fileURLToPath(
        new URL("../plugin-local-inference/src/index.ts", import.meta.url)
      ),
      "@elizaos/plugin-capacitor-bridge": fileURLToPath(
        new URL("../plugin-capacitor-bridge/src/index.ts", import.meta.url)
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    testTimeout: 20_000,
    include: ["__tests__/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "**/*.live.test.ts"],
  },
});
