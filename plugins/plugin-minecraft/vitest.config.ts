import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@elizaos/core": fileURLToPath(
        new URL("../../packages/core/src/index.node.ts", import.meta.url),
      ),
    },
    conditions: ["node"],
  },
  ssr: {
    resolve: {
      conditions: ["node"],
    },
  },
  test: {
    include: ["__tests__/**/*.test.ts", "src/**/*.test.ts"],
    passWithNoTests: true,
    environment: "node",
    server: {
      deps: {
        inline: ["@elizaos/core"],
      },
    },
  },
});
